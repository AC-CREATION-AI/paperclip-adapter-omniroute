/**
 * Exécution d'un run d'agent via la passerelle OmniRoute.
 *
 * Contrairement à `claude_local`, cet adaptateur ne lance aucun binaire : il
 * tourne dans le processus serveur de Paperclip et parle en HTTP à OmniRoute.
 * Le workspace vient de `context.paperclipWorkspace.cwd` (le répertoire de run
 * préparé par Paperclip) et c'est le seul point de persistance entre deux runs.
 *
 * Ordre d'assemblage du prompt, aligné sur `claude_local` :
 *   bootstrap (template configurable) → wake prompt → note de session → tâche.
 *
 * Sur échec de la passerelle, on remonte `errorMessage` / `errorCode` /
 * `errorFamily` / `retryNotBefore` depuis la classification (`shared/errors.ts`)
 * pour que Paperclip suspende le run au lieu de le compter comme un échec
 * définitif. La clé d'API n'est jamais journalisée.
 */
import { loadRemoteModelPricing } from '../shared/pricing.js';
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  TranscriptEntry,
  UsageSummary,
} from '@paperclipai/adapter-utils';
// Les helpers runtime vivent dans le sous-chemin `/server-utils` ; le point
// d'entrée racine n'expose que des types (son `exports` publié n'a qu'une
// condition `types`). Un import de valeur depuis la racine échouerait donc à
// l'exécution chez un tiers — vérifié sur un `npm install` réel.
import {
  applyPaperclipWorkspaceEnv,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  isForbiddenConfigEnvKey,
  isPaperclipRuntimeEnvKey,
  readPaperclipIssueWorkModeFromContext,
  asString,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  selectPaperclipTaskMarkdown,
} from '@paperclipai/adapter-utils/server-utils';

import { OmniRouteError, OmniRouteClient , combineWithDeadline, withDeadline } from '../shared/client.js';
import { resolveConfig } from '../shared/config.js';
import { MAX_LENGTH_CONTINUATIONS, runAgentLoop } from './agent-loop.js';
import { delegationResultFields } from './escalation.js';
import { startPhase } from './phase-timing.js';
import {
  asOmniRouteContext,
  buildFailureResult,
  INTERRUPTED_RECOVERY,
  type OmniRouteCostReceipt,
  type OmniRouteExecutionResult,
} from './contract.js';
import {
  buildInstructionsSection,
  buildReadInstructionsTool,
  loadInstructionsBundle,
  type InstructionsBundle,
} from './instructions.js';
import {
  buildReadSkillTool,
  buildSkillIndex,
  enrichSkillDescriptions,
  filterAvailableMounts,
  resolveDesiredSkillMounts,
  type SkillMount,
} from './skills.js';
import { resolveHistoryBudgetChars, resolveIntraRunBudgetChars } from './session.js';
import { calculateDynamicSessionBudgets } from '../shared/context-window.js';
import { loadContextBudget } from '../shared/context-budget.js';
import { isHistoryRejection, openRunSession, RunCheckpointer, startFreshAttempt } from './session-run.js';
import { collectSecretValues, createRedactor, guardToolOutputs, redactJsonValue } from './secrets-redact.js';
import type { WireMessage } from '../shared/wire.js';
import { getModelContextLength } from './models.js';
import { buildWorkspaceTools, prepareWorkspace } from './tools.js';
import {
  buildPaperclipTools,
  paperclipToolsAvailability,
  paperclipToolsOptionsFromEnv,
} from './paperclip-tools.js';
import { buildMcpBridgeTools } from './mcp-bridge.js';
import { discoverPluginTools } from './plugin-tools.js';

export async function execute(ctx: AdapterExecutionContext): Promise<OmniRouteExecutionResult> {
  // Le serveur fournit `onProviderStopped`, que les types de la version liée
  // ne déclarent pas : on convertit le contexte une fois, ici.
  // Voir `contract.ts` pour la mesure de cet écart.
  const context = asOmniRouteContext(ctx);
  const config = resolveConfig(ctx.config ?? {});

  /**
   * Deadline globale du run.
   *
   * `timeoutSec` ne doit pas être un délai *par requête* : il est annoncé
   * comme « délai du run ». Avant, chaque requête HTTP repartait avec un
   * nouveau délai complet, si bien qu'une boucle de 8 tours pouvait dépasser
   * le budget annoncé d'un facteur 8.
   *
   * On crée donc **un seul** signal de deadline pour tout le run, et on le
   * combine avec le signal d'annulation de l'hôte.
   */
  const deadlineSignal = withDeadline(config.timeoutSec * 1000);
  const signal = ctx.signal
    ? combineWithDeadline(ctx.signal, deadlineSignal)
    : deadlineSignal;

  const log = async (stream: 'stdout' | 'stderr', text: string): Promise<void> => {
    await ctx.onLog(stream, text.endsWith('\n') ? text : `${text}\n`);
  };
  const warn = async (text: string): Promise<void> => log('stderr', `[omniroute_native] ${text.trimEnd()}`);

  /**
   * Annulation : on s'inscrit au signal de l'hôte **avant** de commencer à
   * travailler.
   *
   * Sans cet appel, l'hôte ne sait pas que l'adaptateur respecte le signal :
   * il peut tuer le run (SIGKILL du processus) pendant que la requête HTTP
   * vers la passerelle est encore ouverte — le travail continue côté
   * fournisseur et se facture, alors que l'agent est déjà mort.
   *
   * On s'inscrit donc avant toute requête à la passerelle, puis on vérifie
   * `signal.aborted` : l'hôte a pu annuler entre-temps.
   *
   * Aucune requête n'est partie à ce stade : on ne déclare donc pas le
   * fournisseur arrêté (`onProviderStopped` vaut « après la dernière
   * invocation confirmée arrêtée »).
   */
  await ctx.onCancellationReady?.();
  if (signal?.aborted) {
    return cancelledResult(config.model, 'Annulation reçue avant le démarrage de la passe-relle.');
  }

  // `onMeta` est optionnel dans le contrat : certains hôtes ne l'implémentent
  // pas. On l'appelle donc sans en dépendre.
  await ctx.onMeta?.({
    adapterType: 'omniroute_native',
    command: 'omniroute',
    commandArgs: [config.model],
    context: ctx.context,
  });

  await log(
    'stdout',
    `[omniroute_native] passerelle ${config.baseUrl} · modèle ${config.model} · clé ${config.apiKeySource}`,
  );

  if (!config.apiKey) {
    // Pas de clé : inutile d'appeler la passerelle pour récolter un 401. On
    // échoue tout de suite avec un code exploitable par l'opérateur.
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        'Aucune clé API OmniRoute configurée. Renseignez `apiKey` dans la config de l’adaptateur, ou OMNIROUTE_API_KEY / ANTHROPIC_API_KEY dans les variables de l’agent (`env`) ou du serveur.',
      errorCode: 'omniroute_auth_rejected',
      errorFamily: null,
      retryNotBefore: null,
      provider: 'omniroute_native',
      model: config.model,
      billingType: 'api',
      executionRecovery: { kind: 'bootstrap', providerWorkStarted: false },
    };
  }

  const endPlaceWorkspace = startPhase(ctx.onEvent, 'place_workspace');
  const workspaceCwd = resolveWorkspaceCwd(ctx);
  if (!workspaceCwd) {
    await endPlaceWorkspace('failed');
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        'Aucun répertoire de travail dans `context.paperclipWorkspace.cwd` : l’adaptateur ne peut pas exposer ses outils de fichier.',
      errorCode: 'omniroute_missing_workspace',
      errorFamily: null,
      retryNotBefore: null,
      provider: 'omniroute_native',
      model: config.model,
      billingType: 'api',
      executionRecovery: { kind: 'bootstrap', providerWorkStarted: false },
    };
  }
  await log('stdout', `[omniroute_native] workspace ${workspaceCwd}`);

  // Le temporaire du shell est le sous-dossier `.tmp` du workspace : il doit
  // exister, sinon `mktemp`, `pip` ou `npm` échouent faute de répertoire.
  try {
    await prepareWorkspace(workspaceCwd);
  } catch (error) {
    await endPlaceWorkspace('failed');
    throw error;
  }
  await endPlaceWorkspace('ok');

  const client = new OmniRouteClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    requestTimeoutMs: config.requestTimeoutMs,
  });

  // Frontière de dispatch : cet adaptateur n'a pas de processus local, donc
  // le franchissement de la première requête à la passerelle *est* la
  // frontière. On la signale avant l'appel, comme le fait `cursor-cloud`.
  ctx.onDispatch?.();

  // Un modèle configuré qui n'existe pas côté passerelle doit se replier, pas
  // faire échouer le run : on ne pré-valide donc que si un repli est prévu.
  // Lot 22 : chargement anticipé du barème officiel auprès d'OmniRoute si pas en cache
  void loadRemoteModelPricing(config.baseUrl, config.apiKey ?? '', config.model).catch(() => undefined);
  const model = selectModel(config);

  const mcpServers = (context.runtimeMcp ?? (ctx as { runtimeMcp?: { getServers(): any[] } }).runtimeMcp)?.getServers() ?? [];
  const mcpTokensRecord: Record<string, string> = {};
  for (let i = 0; i < mcpServers.length; i++) {
    const s = mcpServers[i];
    if (s && typeof s.token === 'string' && s.token.trim().length > 0) {
      mcpTokensRecord[`MCP_TOKEN_${i}_${s.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = s.token;
    }
  }

  // Lot sécu (ACC-2300) : valeurs secrètes connues du run (jeton de run, clé
  // de la passerelle, jetons serveurs MCP, variables secrètes du shell et du conteneur), masquées
  // partout — sorties d'outils, transcript, fichier de session.
  const redact = createRedactor([
    ...collectSecretValues(
      agentShellEnv(ctx),
      process.env,
      { OMNIROUTE_API_KEY: config.apiKey },
      mcpTokensRecord,
    ),
    ...mcpServers.map((s: any) => s.token).filter((t: any): t is string => typeof t === 'string'),
  ]);
  const emit = async (entry: TranscriptEntry): Promise<void> => {
    // Masquage champ par champ, jamais sur le JSON sérialisé (un `\"` coupé
    // casserait la ligne de transcript).
    await log('stdout', JSON.stringify(redactJsonValue(entry, redact)));
  };

  // ── Continuité de session ────────────────────────────────────────────────
  // OmniRoute n'a pas de session côté fournisseur. La session Paperclip, si,
  // existe : le serveur la persiste et la redonne dans
  // `ctx.runtime.sessionParams`. On la matérialise donc nous-mêmes, sous
  // forme d'historique rejoué devant le modèle (dossier stable et privé,
  // écriture atomique sous verrou, purge : voir `session-run.ts`).
  const endEnsureSession = startPhase(ctx.onEvent, 'ensure_session');
  // ACC-3085 — fenêtre lue à OmniRoute (modèle et repli), jamais écrite à la main.
  const contextBudget = await loadContextBudget({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey ?? '',
    model: config.model,
    fallbackModel: config.fallbackModel,
    signal,
  });
  const { historyBudgetChars, intraRunBudgetChars } = calculateDynamicSessionBudgets(contextBudget.tokens);
  const manualChars = typeof config.maxContextChars === 'number' && config.maxContextChars > 0
    ? config.maxContextChars
    : null;
  const historyBudget = manualChars ?? historyBudgetChars;
  const intraRunBudget = manualChars ?? intraRunBudgetChars;
  const maxTokens = contextBudget.maxOutputTokens !== null
    ? Math.min(config.maxTokens, contextBudget.maxOutputTokens)
    : config.maxTokens;
  const contextWindow = {
    ...contextBudget,
    source: manualChars !== null ? 'config' as const : contextBudget.source,
    historyBudgetChars: historyBudget,
    intraRunBudgetChars: intraRunBudget,
  };
  await log(
    'stdout',
    `[omniroute_native] fenêtre de contexte ${contextWindow.tokens} tokens (source ${contextWindow.source} ; ${contextBudget.models.map((m) => `${m.id} ${m.tokens ?? 'inconnue'}`).join(', ')}) · sortie max ${maxTokens}`,
  );
  const session = await openRunSession({
    context: ctx.context, runtime: ctx.runtime, workspaceCwd, historyBudget, redact,
    log: (text) => log('stdout', text), warn,
  });
  await endEnsureSession('ok');
  let sessionParams = session.attempt.params;
  const checkpointer = new RunCheckpointer(session, context.onUsage, warn);
  if (!session.attempt.resumed && typeof (ctx as unknown as Record<string, unknown>)['getFreshSessionHandoff'] === 'function') {
    delete ctx.context?.['paperclipFreshSessionHandoffMarkdown'];
    try {
      const getHandoff = (ctx as unknown as { getFreshSessionHandoff: () => Promise<string | null> }).getFreshSessionHandoff;
      const handoff = await getHandoff();
      if (typeof handoff === 'string' && handoff.trim().length > 0) {
        if (!ctx.context || typeof ctx.context !== 'object') {
          (ctx as unknown as { context: Record<string, unknown> }).context = {};
        }
        (ctx.context as Record<string, unknown>)['paperclipFreshSessionHandoffMarkdown'] = handoff.trim();
        await log('stdout', '[omniroute_native] handoff de session compactée injecté dans le contexte');
      }
    } catch {
      // Télémétrie/handoff optionnel : ne fait jamais échouer le run.
    }
  }

  if (session.attempt.resumed) {
    await log(
      'stdout',
      `[omniroute_native] session ${sessionParams.sessionId} reprise — ${session.attempt.history.length} message(s) rejoués`,
    );
  }
  // Reprise réelle → prompt delta compact (comme claude_local) ; sinon brief complet.
  const prompt = buildPrompt(ctx, { resumedSession: session.attempt.resumed });

  // ── Skills et instructions ──────────────────────────────────────────────
  // Le bundle d'instructions est une instruction durable de l'agent : il
  // prime sur tout le reste du prompt. Un bundle illisible est un problème
  // d'opérateur : on le remonte plutôt que de laisser croire à l'agent
  // qu'il n'a pas d'instructions.
  const endConfigureSession = startPhase(ctx.onEvent, 'configure_session');
  let instructions: InstructionsBundle | null = null;
  try {
    instructions = await loadInstructionsBundle(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endConfigureSession('failed');
    await warn(message);
    // `errorFamily: 'configuration'` : le serveur l'accepte et n'en fait
    // aucun traitement de reprise (seuls `transient_upstream` et
    // `provider_quota` sont rejoués) — c'est donc le bon marqueur pour une
    // erreur de configuration : un échec définitif, jamais rejoué.
    return buildFailureResult({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: 'omniroute_instructions_unreadable',
      errorFamily: 'configuration',
      retryNotBefore: null,
      provider: 'omniroute_native',
      model,
      billingType: 'api',
    });
  }

  // Un skill dont la source a disparu est écarté : l'index du prompt ne
  // doit pas proposer une entrée qui mène nulle part.
  const skillMounts: SkillMount[] = await enrichSkillDescriptions(
    await filterAvailableMounts(
      resolveDesiredSkillMounts((ctx.config ?? {}) as Record<string, unknown>),
    ),
  );
  if (skillMounts.length > 0) {
    await log(
      'stdout',
      `[omniroute_native] ${skillMounts.length} skill(s) monté(s) : ${skillMounts.map((m) => m.runtimeName).join(', ')}`,
    );
  }

  if (mcpServers.length > 0) {
    await log(
      'stdout',
      `[omniroute_native] ${mcpServers.length} serveur(s) MCP connecté(s) : ${mcpServers.map((s: any) => s.name).join(', ')}`,
    );
  }
  const mcpBridgeTools = mcpServers.length > 0
    ? buildMcpBridgeTools({
        servers: mcpServers,
        runId: ctx.runId,
        agentId: ctx.agent.id,
        companyId: ctx.agent.companyId,
        signal,
        timeoutMs: config.timeoutSec ? Math.min(30_000, config.timeoutSec * 1000) : 30_000,
        redactSecrets: redact,
      })
    : [];

  const shellEnv = agentShellEnv(ctx);
  const paperclipOptions = paperclipToolsOptionsFromEnv(shellEnv, signal);
  const tools = [
    ...buildWorkspaceTools(workspaceCwd, signal, shellEnv),
    // Lot 9 — outils Paperclip directs : même source que le shell (URL,
    // identité, run id, jeton de run), jeton jamais renvoyé au modèle.
    ...buildPaperclipTools(paperclipOptions),
    ...mcpBridgeTools,
    ...(skillMounts.length > 0 ? [buildReadSkillTool(skillMounts)] : []),
    ...(instructions ? [buildReadInstructionsTool(instructions)].filter((t) => t !== null) : []),
  ];
  // Outils des plugins Paperclip (ex. mémoire Hindsight) : découverts une fois
  // par run, ajoutés en dernier ; les noms ci-dessus gardent la priorité.
  if (config.pluginTools) {
    const projectId = (ctx.context as Record<string, unknown> | undefined)?.['projectId'];
    const plugins = await discoverPluginTools({
      ...paperclipOptions,
      projectId: typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null,
      reservedNames: tools.map((t) => t.spec.name),
      executeTimeoutMs: config.timeoutSec ? Math.min(30_000, config.timeoutSec * 1000) : undefined,
    });
    tools.push(...plugins.tools);
    if (plugins.tools.length > 0 || plugins.skipped.length > 0 || (plugins.note && paperclipToolsAvailability(paperclipOptions).paperclip)) {
      await log('stdout', `[omniroute_native] outils de plugin : ${plugins.tools.length > 0 ? plugins.tools.map((t) => t.spec.name).join(', ') : `aucun (${plugins.note ?? 'aucun'})`}${plugins.skipped.length > 0 ? ` ; écartés : ${plugins.skipped.join(', ')}` : ''}`);
    }
  }

  const system = buildSystemPrompt(ctx, instructions, skillMounts);
  await endConfigureSession('ok');

  const started = Date.now();
  // Portée de diagnostic `adapter_execution` (adapter-utils/execution-phase.ts) :
  // le serveur chronomètre la boucle ; un puits cassé ne doit rien changer au run.
  let releasePhase: (() => void) | void = undefined;
  try {
    releasePhase = context.onExecutionPhase?.('adapter_execution');
  } catch {
    /* diagnostic seulement */
  }
  const endTurn = startPhase(ctx.onEvent, 'turn');
  try {
    const runLoop = (initialUserMessage: string, history: WireMessage[]) => runAgentLoop({
      client,
      model,
      system,
      initialUserMessage,
      history,
      tools: guardToolOutputs(tools, redact),
      maxTokens,
      reasoningEffort: config.reasoningEffort,
      cacheControlPoints: config.cacheControlPoints,
      sessionId: sessionParams.sessionId,
      maxTurns: config.maxTurns,
      intraRunBudget,
      fallbackModel: config.fallbackModel,
      parallelToolCalls: config.parallelToolCalls,
      // Lot 20 — sous-tâches et escalade (désactivées sans réglage).
      subtask: config.subtaskModel
        ? { model: config.subtaskModel, maxTurns: config.subtaskMaxTurns, timeoutSec: config.subtaskTimeoutSec }
        : null,
      escalationModels: config.escalationModels,
      maxEscalations: config.maxEscalations,
      signal,
      emit,
      onProgress: (update) => ctx.onRuntimeProgress?.({
        phase: update.phase as 'adapter_startup',
        message: update.message,
        currentToolName: update.currentToolName ?? null,
      }),
      warn: (message) => warn(message),
      onCheckpoint: checkpointer.onCheckpoint,
    });
    // Historique repris refusé par le modèle (400, contexte dépassé) : un essai
    // à neuf, sans historique, avec une passation courte (A-contrat manque 5).
    const result = await runLoop(prompt, session.attempt.history).catch(async (error: unknown) => {
      if (signal?.aborted || !isHistoryRejection(error, session.attempt, checkpointer.inAttempt)) throw error;
      const previousId = sessionParams.sessionId;
      const fresh = await startFreshAttempt(session, error, redact, historyBudget);
      sessionParams = fresh.attempt.params;
      checkpointer.newAttempt();
      await warn(`historique de la session ${previousId} refusé par le modèle : essai à neuf sur la session ${sessionParams.sessionId}`);
      delete ctx.context?.['paperclipFreshSessionHandoffMarkdown'];
      const hostHandoff = await context.getFreshSessionHandoff?.().catch(() => null);
      return runLoop(
        joinPromptSections([fresh.handoff, typeof hostHandoff === 'string' ? hostHandoff.trim() : '', buildPrompt(ctx, { resumedSession: false })]),
        [],
      );
    });

    const hasFinalResponse =
      (result.completion === 'completed' && result.finalText.trim().length > 0) ||
      result.waitingForHuman === true;
    await endTurn(hasFinalResponse ? 'ok' : 'failed');

    // L'historique est persisté **après** le run : il contient ce que le
    // modèle a dit et fait. Une erreur d'écriture ne doit pas faire échouer
    // un run qui a réussi.
    const endEndSession = startPhase(ctx.onEvent, 'end_session');
    const sessionSaved = await session.attempt.writer.save(result.messages);
    if (!sessionSaved) await warn(`session non écrite : ${session.attempt.writer.lastError ?? 'erreur inconnue'}`);
    await endEndSession(sessionSaved ? 'ok' : 'failed');

    await logGatewayHeaders(result.gatewayHeaders, log);

    // Le fournisseur a été arrêté : on le signale avant de rendre la main,
    // comme l'exige le contrat (`onProviderStopped` : « after the final
    // provider invocation is confirmed stopped »).
    await context.onProviderStopped?.();

    // Un run interrompu n'est pas un succès. Deux causes distinctes :
    // l'annulation demandée par un opérateur, et l'expiration de la deadline
    // globale du run. On les distingue — l'hôte doit pouvoir dire « annulé »
    // (action humaine) et non « expiré » (budget).
    if (signal?.aborted) {
      const hostCancelled = ctx.signal?.aborted === true;
      const cancelled = cancelledResult(
        result.servedModel ?? model,
        hostCancelled
          ? 'Run annulé : le travail a été interrompu et le fournisseur arrêté.'
          : 'Délai du run dépassé : le travail a été interrompu et le fournisseur arrêté.',
      );
      // Une expiration de deadline n'est pas une annulation humaine : on le
      // dit par `timedOut`, et `errorCode` distingue les deux cas.
      if (!hostCancelled) {
        cancelled.timedOut = true;
        cancelled.errorCode = 'omniroute_deadline_exceeded';
      }
      cancelled.usage = runUsage(result);
      cancelled.usageBasis = 'per_run';
      cancelled.costUsd = result.costUsd;
      // Reprise d'un run coupé (ACC-2289) : fournisseur arrêté, session écrite,
      // chaque appel d'outil a son résultat → preuve « interrupted ».
      cancelled.sessionParams = sessionParams;
      cancelled.sessionDisplayId = sessionParams.sessionId;
      if (sessionSaved) cancelled.executionRecovery = { ...INTERRUPTED_RECOVERY };
      cancelled.resultJson = {
        ...cancelled.resultJson,
        turns: result.turns,
        stopReason: result.stopReason ?? 'cancelled',
        durationMs: Date.now() - started,
        cacheWriteTokens: result.cacheWriteTokens,
        gatewayHeaders: result.gatewayHeaders,
        contextWindow,
        ...delegationResultFields(result),
      };
      return cancelled;
    }

    // Sortie coupée même après les relances « continue » : publier ce texte
    // serait publier une réponse fausse. Échec explicite, non rejoué (un
    // nouvel essai produirait la même coupure) — agrandir maxTokens.
    if (result.completion === 'truncated') {
      const truncated = buildFailureResult({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Réponse coupée par la limite de sortie (maxTokens=${maxTokens}) malgré ${MAX_LENGTH_CONTINUATIONS} relance(s) : rien n'est publié.`,
        errorCode: 'omniroute_output_truncated',
        errorFamily: 'configuration',
        retryNotBefore: null,
        provider: 'omniroute_native',
        model: result.servedModel ?? model,
        billingType: 'api',
      });
      truncated.usage = runUsage(result);
      truncated.usageBasis = 'per_run';
      truncated.costUsd = result.costUsd;
      truncated.sessionParams = sessionParams;
      truncated.sessionDisplayId = sessionParams.sessionId;
      truncated.resultJson = { turns: result.turns, stopReason: result.stopReason, completion: result.completion, durationMs: Date.now() - started, contextWindow, ...delegationResultFields(result) };
      return truncated;
    }

    // Lot 13 — statut honnête. Un run sans réponse finale (tours épuisés,
    // dernier tour vide, synthèse impossible) n'est pas un succès : avant ce
    // correctif, 31 runs sur 69 étaient « réussis » sans rien publier. La
    // session est conservée : le run suivant reprend là où celui-ci s'arrête.
    if (!hasFinalResponse) {
      const noFinal = buildFailureResult({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage:
          result.completion === 'max_turns'
            ? `Nombre de tours maximal atteint (maxTurns=${config.maxTurns}) sans réponse finale, même après le tour de synthèse : rien n'est publié.`
            : "Le modèle s'est arrêté sans réponse finale, même après le tour de synthèse : rien n'est publié.",
        errorCode: 'omniroute_no_final_response',
        retryNotBefore: null,
        provider: 'omniroute_native',
        model: result.servedModel ?? model,
        billingType: 'api',
      });
      noFinal.usage = runUsage(result);
      noFinal.usageBasis = 'per_run';
      noFinal.costUsd = resolveRunCostUsd(result.costUsd, result.costTurnsMissing);
      noFinal.sessionParams = sessionParams;
      noFinal.sessionDisplayId = sessionParams.sessionId;
      noFinal.resultJson = {
        turns: result.turns,
        stopReason: result.stopReason,
        completion: result.completion,
        durationMs: Date.now() - started,
        sessionId: sessionParams.sessionId,
        contextWindow,
        ...delegationResultFields(result),
      };
      return noFinal;
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: 'omniroute_native',
      model: result.servedModel ?? model,
      billingType: 'api',
      // Coût rapporté par OmniRoute (somme des `usage.cost` du run) : sans lui,
      // Paperclip affiche « coût inconnu » alors que la passerelle le connaît.
      costUsd: resolveRunCostUsd(result.costUsd, result.costTurnsMissing),
      ...costReceipt(resolveRunCostUsd(result.costUsd, result.costTurnsMissing), result.costTurnsMissing, result.costSource),
      // La session est renvoyée au serveur : il la persiste par tâche et la
      // redonne au run suivant dans `ctx.runtime.sessionParams`. C'est ce qui
      // rend la continuité réelle plutôt que décorative.
      sessionParams,
      sessionDisplayId: sessionParams.sessionId,
      usage: runUsage(result),
      usageBasis: 'per_run',
      resultJson: {
        turns: result.turns,
        stopReason: result.stopReason,
        // `max_turns` : pas de finale ; Paperclip relance et la session rejouée
        // permet de reprendre là où le run s'est arrêté.
        completion: result.completion,
        finalSynthesized: result.finalSynthesized,
        ...(typeof result.waitingForHuman === 'boolean' ? { waitingForHuman: result.waitingForHuman } : {}),
        durationMs: Date.now() - started,
        cacheWriteTokens: result.cacheWriteTokens,
        gatewayHeaders: result.gatewayHeaders,
        sessionId: sessionParams.sessionId,
        resumedSession: session.attempt.resumed,
        ...(session.attempt.freshRetry ? { sessionRestartedFresh: true } : {}),
        // ACC-3085 — fenêtre détectée et seuils appliqués, avec leur source.
        contextWindow,
        ...delegationResultFields(result),
        // Paperclip lit `resultJson.finalResponse` pour décider de la réponse
        // publiée (`heartbeat-run-summary.ts:readMarkedAdapterFinalResponse` :
        // `disposition === "final"` + `text`/`message`). Sans ce champ, un
        // run réussi retombe en `no_user_facing_response` et la réponse du
        // modèle — pourtant produite et présente dans le journal — ne sort
        // jamais en commentaire. Le fallback `summary` existe mais il est
        // filtré par `NARRATION_OPENERS` et n'est pas le contrat natif.
        // Cartes de décision v1.2 : aucune finalResponse ni summary en attente humaine
        // pour ne pas polluer le fil de discussion Paperclip avec un dump JSON d'outil.
        // Masquage (t_e8b687c2) : le texte publié passe par le même masqueur
        // que le transcript et la session — une clé connue renvoyée par le
        // modèle ne sort pas en clair dans le commentaire Paperclip.
        ...(result.completion === 'completed' && !result.waitingForHuman && result.finalText.trim().length > 0
          ? {
              finalResponse: {
                disposition: 'final' as const,
                text: redact(result.finalText),
              },
              summary: redact(result.finalText),
            }
          : {}),
      },
    };
  } catch (error) {
    await endTurn('failed');
    const failed = await toExecutionResult(error, model, warn);
    // Usage et session au dernier point de contrôle : un run qui plante ne
    // perd ni ses jetons ni son historique (ACC-2289).
    const last = checkpointer.last;
    if (last) {
      failed.usage = runUsage(last);
      failed.usageBasis = 'per_run';
      failed.costUsd = resolveRunCostUsd(last.costUsd, last.costTurnsMissing);
    }
    if (session.attempt.freshRetry && !session.attempt.writer.hasSaved) failed.clearSession = true;
    else if (session.attempt.writer.hasSaved || session.attempt.resumed) {
      failed.sessionParams = sessionParams;
      failed.sessionDisplayId = sessionParams.sessionId;
    }
    return failed;
  } finally {
    try {
      if (typeof releasePhase === 'function') releasePhase();
    } catch {
      /* diagnostic seulement */
    }
  }
}

/**
 * Résultat d'un run annulé.
 *
 * Le format suit celui des adaptateurs natifs (`grok-local`, `acpx-engine`) :
 * `exitCode: null`, `errorCode: 'cancelled'`, et un `executionCancellation`
 * dans le `resultJson` pour que l'hôte sache que l'annulation a été
 * **reconnue** — et non subie.
 */
function cancelledResult(model: string, message: string): AdapterExecutionResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorCode: 'cancelled',
    errorMessage: message,
    errorFamily: null,
    retryNotBefore: null,
    provider: 'omniroute_native',
    model,
    billingType: 'api',
    resultJson: {
      executionCancellation: {
        state: 'acknowledged',
        acknowledgedAt: new Date().toISOString(),
      },
    },
  };
}

/**
 * Résout la racine des outils. `paperclipWorkspace` est un objet posé par
 * Paperclip dans le contexte ; `cwd` en est la clé utile et il peut manquer
 * quand le run n'a pas de workspace (mode conversation).
 */
function resolveWorkspaceCwd(ctx: AdapterExecutionContext): string | null {
  const workspace = parseObject(ctx.context?.['paperclipWorkspace']);
  const cwd = asString(workspace?.['cwd'], '');
  return cwd.trim().length > 0 ? cwd : null;
}

/** En-têtes `X-OmniRoute-*` : routage et coût estimé par la passerelle. */
async function logGatewayHeaders(
  headers: Record<string, string>,
  log: (stream: 'stdout' | 'stderr', text: string) => Promise<void>,
): Promise<void> {
  const entries = Object.entries(headers);
  if (entries.length === 0) return;
  await log('stdout', `[omniroute_native] ${entries.map(([key, value]) => `${key}=${value}`).join(' ')}`);
}

/**
 * Choisit le modèle. En cas de modèle introuvable côté passerelle :
 * `fallbackModel` s'il est configuré, sinon on garde le modèle demandé et on
 * laisse l'erreur remonter — un repli silencieux vers un modèle non validé
 * serait pire qu'un échec explicite.
 */
/**
 * Choisit le modèle de départ.
 *
 * Lot 22 — Démarrage instantané (efface 53 s d'attente cumulée sur 9 tâches).
 * On démarre directement sur le modèle configuré (combo `AC-*` ou `auto/*`)
 * sans télécharger les 9,3 Mo de `/v1/models`. Si la passerelle signale que le
 * modèle est indisponible ou introuvable (404, 503, 429), la boucle d'agent
 * (`agent-loop.ts`) bascule dynamiquement sur `fallbackModel` au 1er appel.
 */
function selectModel(config: ReturnType<typeof resolveConfig>): string {
  return config.model;
}

/**
 * Environnement du shell de l'agent.
 *
 * `claude_local` obtient ces variables en les posant sur le processus fils du
 * CLI. Ici il n'y a pas de CLI, donc c'est l'outil `shell` qui doit les porter :
 * sans `PAPERCLIP_API_KEY`, l'agent ne peut pas appeler l'API du board et ne
 * peut donc pas mettre à jour son ticket.
 *
 * Le jeton vient **exclusivement** de `ctx.authToken` (JWT de run minté par
 * l'harness). `PAPERCLIP_API_KEY` est volontairement absent de `resolveConfig`
 * pour qu'une valeur posée en config ne puisse jamais usurper ce rôle.
 */
function agentShellEnv(ctx: AdapterExecutionContext): Record<string, string> {
  const context = (ctx.context ?? {}) as Record<string, unknown>;
  const env: Record<string, string> = {
    ...buildPaperclipEnv({ id: ctx.agent.id, companyId: ctx.agent.companyId }),
    ...agentIdentityEnv((ctx as { agentIdentity?: unknown }).agentIdentity),
  };
  env['PAPERCLIP_RUN_ID'] = ctx.runId;

  // Lot 8b — variables de mission, mêmes règles que claude_local
  // (claude-local/src/server/execute.ts:221-296) : sans elles l'agent ne
  // connaît pas son ticket (`PAPERCLIP_TASK_ID` vide, mesuré sur ACC-2278).
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  const records = (value: unknown): Array<Record<string, unknown>> =>
    Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      : [];
  const mission: Record<string, string | null> = {
    PAPERCLIP_TASK_ID: text(context['taskId']) ?? text(context['issueId']),
    PAPERCLIP_ISSUE_WORK_MODE: readPaperclipIssueWorkModeFromContext(context),
    PAPERCLIP_WAKE_REASON: text(context['wakeReason']),
    PAPERCLIP_WAKE_COMMENT_ID: text(context['wakeCommentId']) ?? text(context['commentId']),
    PAPERCLIP_APPROVAL_ID: text(context['approvalId']),
    PAPERCLIP_APPROVAL_STATUS: text(context['approvalStatus']),
  };
  for (const [key, value] of Object.entries(mission)) if (value) env[key] = value;
  const linkedIssueIds = Array.isArray(context['issueIds'])
    ? (context['issueIds'] as unknown[]).map(text).filter((v): v is string => v !== null)
    : [];
  if (linkedIssueIds.length > 0) env['PAPERCLIP_LINKED_ISSUE_IDS'] = linkedIssueIds.join(',');

  const workspace = parseObject(context['paperclipWorkspace']);
  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: text(workspace['cwd']),
    workspaceSource: text(workspace['source']),
    workspaceStrategy: text(workspace['strategy']),
    workspaceId: text(workspace['workspaceId']),
    workspaceRepoUrl: text(workspace['repoUrl']),
    workspaceRepoRef: text(workspace['repoRef']),
    workspaceBranch: text(workspace['branchName']),
    workspaceWorktreePath: text(workspace['worktreePath']),
    agentHome: text(workspace['agentHome']),
  });
  const jsonLists: Array<[string, unknown]> = [
    ['PAPERCLIP_WORKSPACES_JSON', context['paperclipWorkspaces']],
    ['PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON', context['paperclipRuntimeServiceIntents']],
    ['PAPERCLIP_RUNTIME_SERVICES_JSON', context['paperclipRuntimeServices']],
  ];
  for (const [key, value] of jsonLists) {
    const list = records(value);
    if (list.length > 0) env[key] = JSON.stringify(list);
  }
  const primaryUrl = text(context['paperclipRuntimePrimaryUrl']);
  if (primaryUrl) env['PAPERCLIP_RUNTIME_PRIMARY_URL'] = primaryUrl;

  // Variables configurées sur l'agent (`config.env`), comme claude_local : les
  // variables runtime PAPERCLIP_* gagnent, PAPERCLIP_API_KEY ne vient jamais
  // de la config.
  for (const [key, value] of Object.entries(parseObject(ctx.config?.['env']))) {
    if (typeof value !== 'string') continue;
    if (isForbiddenConfigEnvKey(key)) continue;
    if (isPaperclipRuntimeEnvKey(key) && key in env) continue;
    env[key] = value;
  }

  return {
    ...env,
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
    ...(ctx.authToken ? { PAPERCLIP_API_KEY: ctx.authToken } : {}),
  };
}

/**
 * Identité cryptographique de l'agent (hôte récent : `ctx.agentIdentity`),
 * posée comme claude_local via `buildAgentIdentityEnv`. Écrite ici pour ne pas
 * dépendre de la version d'adapter-utils embarquée.
 */
function agentIdentityEnv(identity: unknown): Record<string, string> {
  const record = parseObject(identity);
  const keyId = typeof record['keyId'] === 'string' ? record['keyId'] : '';
  if (!keyId) return {};
  const out: Record<string, string> = { PAPERCLIP_AGENT_KEY_ID: keyId };
  if (typeof record['publicKeyPem'] === 'string') out['PAPERCLIP_AGENT_PUBLIC_KEY'] = record['publicKeyPem'];
  if (typeof record['privateKeyPem'] === 'string') out['PAPERCLIP_AGENT_PRIVATE_KEY'] = record['privateKeyPem'];
  return out;
}

/** Variante exportée pour les tests : l'environnement du shell de l'agent. */
export function buildAgentShellEnvForTest(ctx: AdapterExecutionContext): Record<string, string> {
  return agentShellEnv(ctx);
}
/**
 * Prompt utilisateur : wake prompt + tâche assignée.
 *
 * Même composition que `claude_local` (bootstrap → wake → passation →
 * tâche → prompt heartbeat), pour que le comportement de l'agent — checkout,
 * disposition finale, contrat d'exécution — ne dépende pas du transport. Le
 * wake prompt est rendu *après* la tâche pour pouvoir supprimer sa copie de la
 * description : le brief arrive par le markdown de tâche, une seule fois.
 */
function buildPrompt(ctx: AdapterExecutionContext, options: { resumedSession: boolean } = { resumedSession: false }): string {
  const context = ctx.context ?? {};
  const agent = ctx.agent;
  const templateData = {
    agent: { id: agent.id, name: agent.name, companyId: agent.companyId },
    run: { id: ctx.runId },
    context,
  };

  // 1. Passation de session précédente (compactée ou transmise par l'hôte)
  const freshHandoffRaw = context['paperclipFreshSessionHandoffMarkdown'];
  const freshHandoff = typeof freshHandoffRaw === 'string' ? freshHandoffRaw.trim() : '';
  const sessionHandoffNote = asString(context['paperclipSessionHandoffMarkdown'], '').trim();

  const handoffSection = options.resumedSession ? '' : freshHandoff.length > 0
    ? `## Passation de session précédente\n\n${freshHandoff}`
    : sessionHandoffNote.length > 0
      ? `## Passation de session précédente\n\n${sessionHandoffNote}`
      : '';

  // 2. Note contextuelle de la tâche et Wake Prompt
  const taskContextNote = selectPaperclipTaskMarkdown(context, { resumedSession: options.resumedSession });
  const wakePrompt = renderPaperclipWakePrompt(context['paperclipWake'], {
    resumedSession: options.resumedSession,
    conversationMode: context['conversationMode'] === true,
    // Le markdown de tâche est le brief autoritaire sur ce canal ; on retire la
    // description du wake prompt pour ne pas la porter deux fois.
    suppressIssueDescription: taskContextNote.length > 0,
  });

  // 3. Gabarit prompt d'action
  const promptTemplate =
    asString(ctx.config?.['promptTemplate'], '').trim() || DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE;
  // Sur un delta de reprise (wake prompt non vide) ou une reprise après
  // incident, le prompt heartbeat complet serait redondant : on l'omet.
  const renderedPrompt = (options.resumedSession && wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context['paperclipWake'])
    ? ''
    : renderTemplate(promptTemplate, templateData);

  // 4. Assemblage dans le premier message utilisateur
  return joinPromptSections([
    handoffSection,
    wakePrompt,
    taskContextNote,
    renderedPrompt,
  ]);
}

/**
 * Section d'environnement invariante : annonce le contrat des variables sans valeurs éphémères.
 */
function buildInvariantEnvironmentSection(): string {
  return [
    '## Environnement Paperclip',
    '',
    'Ces variables d\'infrastructure sont disponibles dans le shell quand l\'environnement le supporte :',
    '- `PAPERCLIP_API_URL` : URL de base du serveur Paperclip.',
    '- `PAPERCLIP_AGENT_ID` : Identifiant de cet agent.',
    '- `PAPERCLIP_COMPANY_ID` : Identifiant de l\'organisation.',
    '- `AGENT_HOME` : Répertoire de base de l\'agent.',
    '',
    'Variables propres à chaque mission injectées dans le shell :',
    'PAPERCLIP_TASK_ID, PAPERCLIP_RUN_ID, PAPERCLIP_WAKE_REASON, PAPERCLIP_WORKSPACE_CWD.',
    'Utilisez `$PAPERCLIP_TASK_ID` pour référencer le ticket courant.',
    '',
    'Les jetons d\'authentification (`PAPERCLIP_API_KEY`, `PAPERCLIP_RUNTIME_TOOLS_TOKEN`) sont configurés dans le shell.',
    'Ne les affichez jamais dans vos réponses ou journaux.',
  ].join('\n');
}

/**
 * Section des outils Paperclip invariante : formulation universelle et stable.
 */
function buildInvariantPaperclipToolsSection(): string {
  return [
    '## Outils Paperclip',
    '',
    'Pour lire et modifier les tickets, utilisez prioritairement les outils `paperclip_*` :',
    '- Lire : `paperclip_get_issue` (ticket courant par défaut), `paperclip_list_comments`, `paperclip_get_document`, `paperclip_list_documents`.',
    '- Écrire : `paperclip_add_comment`, `paperclip_update_issue`, `paperclip_write_document`, `paperclip_create_subtask`.',
    '- Décider, si exposés : `paperclip_ask_user` (questions structurées), `paperclip_request_confirmation` (approbation d’un plan). Après une carte réussie, attendre la réponse humaine sans autre outil ni synthèse.',
    '- Livrer : `paperclip_deliver` publie document + commentaire + statut séquentiellement ; il s’arrête au premier échec et indique ce qui a été fait.',
    '- Autre route d\'API : `paperclip_api_request`.',
    'Lorsque les outils `connections_search` et `connection_request` sont présents dans la liste d\'outils, utilisez-les pour les interactions de connexion ; sinon, signalez le besoin d\'accès en commentaire.',
    'Le shell reste réservé aux opérations locales (fichiers du workspace, git, scripts de validation).',
  ].join('\n');
}

/**
 * Prompt système 100 % invariant (v1.3).
 *
 * Garanti strictement identique entre tous les runs d'un agent.
 * Aucune note de passation, aucun horodatage, aucun état dynamique d'outils.
 */
function buildMcpToolsSection(): string {
  return [
    '## Outils MCP et Connexions d’Entreprise',
    '',
    'Lorsque `mcp_search_tools` et `mcp_run_tool` sont exposés, utilisez-les pour les outils d’entreprise via la passerelle Paperclip ; sinon, signalez le besoin d’accès sans inventer d’appel.',
    '- Utilisez `mcp_search_tools` pour trouver les outils disponibles par mot-clé (ex: "github", "cloudflare", "sql").',
    '- Utilisez `mcp_run_tool` avec le nom de l’outil et ses arguments pour l’exécuter.',
    'N’inventez pas de nom d’outil : cherchez d’abord avant d’exécuter.',
  ].join('\n');
}

function buildSystemPrompt(
  ctx: AdapterExecutionContext,
  instructions: InstructionsBundle | null = null,
  skillMounts: SkillMount[] = [],
): string {
  const configured = asString(ctx.config?.['systemPrompt'], '').trim();
  if (configured.length > 0) return configured;

  // Tri alphabétique déterministe des skills pour garantir l'identité binaire du cache
  const sortedMounts = [...skillMounts].sort((a, b) => a.runtimeName.localeCompare(b.runtimeName));

  return joinPromptSections([
    `Vous êtes l'agent Paperclip « ${ctx.agent.name} » (${ctx.agent.id}), exécuté via la passerelle OmniRoute.`,
    buildInstructionsSection(instructions),
    buildSkillIndex(sortedMounts),
    buildInvariantEnvironmentSection(),
    buildInvariantPaperclipToolsSection(),
    buildMcpToolsSection(),
  ]);
}

/**
 * Variante exportée pour les tests : le prompt système seul, sans exécution.
 *
 * Le test doit pouvoir vérifier ce qui part (et ce qui ne part pas) dans le
 * transcript du modèle, sans déclencher de run ni d'appel à la passerelle.
 */
export function buildSystemPromptForTest(
  ctx: AdapterExecutionContext,
  instructions: InstructionsBundle | null = null,
  skillMounts: SkillMount[] = [],
): string {
  return buildSystemPrompt(ctx, instructions, skillMounts);
}

export function buildPromptForTest(
  ctx: AdapterExecutionContext,
  options: { resumedSession: boolean } = { resumedSession: false },
): string {
  return buildPrompt(ctx, options);
}

/**
 * Traduit un échec de passerelle en résultat d'exécution Paperclip. On conserve
 * la classification (`errorCode`, `errorFamily`, `retryNotBefore`) pour que la
 * reprise soit décidée sur la bonne base, et on journalise le diagnostic.
 */
async function toExecutionResult(
  error: unknown,
  model: string,
  warn: (message: string) => Promise<void>,
): Promise<AdapterExecutionResult> {
  if (error instanceof OmniRouteError) {
    const classified = error.classified;
    await warn(`${classified.errorCode} — ${classified.summary}`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: /timed? ?out/i.test(error.message),
      errorMessage: error.message,
      errorCode: classified.errorCode,
      errorFamily: classified.family,
      // `retryNotBefore` vient de `Retry-After` quand la passerelle l'a fourni ;
      // la classification l'a déjà converti en horodatage absolu et plafonné.
      retryNotBefore: classified.retryNotBefore,
      errorMeta: { gatewayStatus: error.status, retryable: classified.retryable },
      provider: 'omniroute_native',
      model,
      billingType: 'api',
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  await warn(`échec du run : ${message}`);
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: message,
    errorCode: 'omniroute_run_failed',
    errorFamily: null,
    retryNotBefore: null,
    provider: 'omniroute_native',
    model,
    billingType: 'api',
  };
}

/**
 * Usage du run au format de l'hôte récent (`UsageSummary.cacheWriteTokens`,
 * sous-ensemble de `inputTokens`). Le type local d'adapter-utils est plus
 * ancien : l'objet est construit hors littéral pour rester compatible.
 */
function runUsage(result: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): UsageSummary {
  const usage = {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cachedInputTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
  };
  return usage;
}

/**
 * Lot 10 — coût du run. Si des tours n'ont reçu aucun coût et que les autres
 * valent 0, on ne sait rien : le coût est **inconnu** (`null`), pas « 0 $ ».
 * Mesuré run 7ca692c0 : 0 $ « estimé » avec 14 tours sur 19 sans coût.
 */
export function resolveRunCostUsd(costUsd: number | null, missingTurns: number): number | null {
  if (costUsd === null) return null;
  if (missingTurns > 0 && costUsd === 0) return null;
  return costUsd;
}

/**
 * Statut du coût pour le grand livre Paperclip (run-completion.ts) : `reported`
 * seulement si **chaque** tour a reçu un coût de la passerelle ; s'il en manque,
 * la somme est un minorant et on le dit (`estimated`) au lieu de l'affirmer.
 */
function costReceipt(
  costUsd: number | null,
  missingTurns: number,
  costSource?: 'provider_reported' | 'rate_card',
): OmniRouteCostReceipt {
  if (costUsd === null) return {};
  if (costSource === 'rate_card') {
    return {
      costStatus: 'estimated',
      pricingProvenance: {
        source: 'rate_card',
        evidence: 'barème officiel OmniRoute (/v1/models/{id}) appliqué aux compteurs SSE',
      },
    };
  }
  return {
    costStatus: missingTurns > 0 ? 'estimated' : 'reported',
    pricingProvenance: {
      source: 'provider_reported',
      evidence: missingTurns > 0
        ? `omniroute usage.cost (${missingTurns} tour(s) sans coût)`
        : 'omniroute usage.cost / x-omniroute-response-cost',
    },
  };
}
