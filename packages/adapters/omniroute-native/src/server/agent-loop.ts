/**
 * Borne l'historique intra-run (audit A10) pour éviter l'explosion de contexte
 * si le modèle répète des lectures volumineuses.
 * Conserve toujours l’objectif du run courant (consigne) et les tours récents
 * complets (assistant + réponses d'outils associées), sans jamais créer
 * d'orphelins.
 */
export function pruneIntraRunHistory(
  messages: WireMessage[],
  budget: number = 100_000,
  currentPromptIndex: number = 0,
): WireMessage[] {
  if (messages.length <= 1 || messages.reduce((n, m) => n + JSON.stringify(m).length, 0) <= budget) return messages;
  const first = messages[currentPromptIndex]!;
  const rest = messages.slice(currentPromptIndex + 1);

  const turns: WireMessage[][] = [];
  let current: WireMessage[] = [];
  for (const msg of rest) {
    if (msg.role === 'assistant' && current.length > 0) {
      turns.push(current);
      current = [msg];
    } else {
      current.push(msg);
    }
  }
  if (current.length > 0) turns.push(current);

  const kept: WireMessage[][] = [];
  let total = JSON.stringify(first).length;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]!;
    const size = turn.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
    if (kept.length > 0 && total + size > budget) break;
    total += size;
    kept.unshift(turn);
  }

  return [first, ...kept.flat()];
}

import { trimSessionMessages } from './session.js';
/**
 * Boucle d'agent : elle pilote les allers-retours modèle ↔ outils.
 *
 * Pourquoi cette boucle vit dans l'adaptateur et non dans un CLI : les autres
 * adaptateurs Paperclip (`claude_local`, `codex_local`…) délèguent l'outillage
 * à un binaire local qui exécute lui-même ses commandes. OmniRoute ne fournit
 * que l'inférence ; il n'y a aucun binaire derrière. Sans boucle ici, l'agent
 * ne pourrait ni lire ni écrire de fichier, et l'adaptateur ne serait qu'un
 * relais de chat.
 *
 * Deux invariants à ne pas casser :
 *
 * 1. **Fidélité du tour assistant.** Avec le raisonnement étendu, les blocs
 *    renvoyés par le modèle (y compris leur `signature`) doivent lui être
 *    réémis à l'identique. On conserve donc les blocs bruts et on les rejoue
 *    tels quels — jamais une reconstruction approximative.
 * 2. **Un `tool_result` par `tool_use`.** L'API rejette un tour où un appel
 *    d'outil n'a pas sa réponse. Chaque appel reçoit donc un résultat, y
 *    compris en cas de refus ou d'annulation.
 */
import type { TranscriptEntry } from '@paperclipai/adapter-utils';

import { INVALID_ARGUMENTS_KEY, OmniRouteError, remainingMs, type OmniRouteClient, type WireContentBlock, type WireMessage } from '../shared/client.js';
import type { ReasoningEffort } from '../shared/chat-completions.js';
import type { WorkspaceTool } from './tools.js';
import {
  DEFAULT_MAX_ESCALATIONS,
  MIN_ESCALATION_REMAINING_MS,
  STUCK_TOOL_ERROR_THRESHOLD,
  escalationPrompt,
  escalationReason,
  describeEscalationReason,
  nextEscalationModel,
  type EscalationRecord,
} from './escalation.js';
import {
  SUBTASK_MAX_PARALLEL,
  SUBTASK_TOOL_NAME,
  buildSubtaskTool,
  createLimiter,
  type ChildLoopResult,
  type SubtaskRecord,
  type SubtaskSettings,
} from './subtask.js';

export type { EscalationRecord } from './escalation.js';
export type { SubtaskRecord, SubtaskSettings } from './subtask.js';

export interface AgentLoopOptions {
  client: OmniRouteClient;
  model: string;
  system: string;
  initialUserMessage: string;
  /**
   * Historique de session rejoué **avant** le message courant.
   *
   * OmniRoute n'a pas de session côté fournisseur : la continuité passe donc
   * par le rejeu de l'historique. Cet historique vient du fichier de session
   * du run précédent (voir `server/session.ts`).
   */
  history?: WireMessage[];
  tools: WorkspaceTool[];
  maxTokens: number;
  /** Niveau `reasoning_effort` (Chat Completions) ; `none` = champ omis. */
  reasoningEffort: ReasoningEffort;
  /** Extension OmniRoute : `cache_control_points`, passés tels quels. */
  cacheControlPoints?: unknown;
  sessionId?: string;
  maxTurns: number;
  intraRunBudget?: number;
  fallbackModel?: string | null;
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
  /** Reçoit chaque entrée de transcript, dans l'ordre. */
  emit(entry: TranscriptEntry): Promise<void>;
  /**
   * Progression runtime : permet à l'hôte d'afficher l'outil en cours.
   * Sans cela, l'UI reste figée pendant toute la boucle d'outils.
   */
  onProgress?: (update: { phase: string; message: string; currentToolName?: string | null }) => void | Promise<void>;
  /** Trace une ligne de diagnostic (stderr) sans polluer le transcript. */
  warn(message: string): Promise<void>;
  /**
   * Lot 20 — outil `subtask` (lecture déléguée à un modèle rapide). Absent ou
   * `null` = outil non proposé (comportement inchangé).
   */
  subtask?: SubtaskSettings | null;
  /**
   * Lot 20 — échelle d'escalade sur échec réel, dans l'ordre. Vide = pas
   * d'escalade (comportement inchangé).
   */
  escalationModels?: string[];
  /** Nombre maximal d'escalades par run (défaut 1). */
  maxEscalations?: number;
  /**
   * Point de contrôle à la fin de chaque tour d'outils (fil complet et usage
   * cumulé du run) : un run coupé ne perd ni l'historique ni l'usage. Une
   * erreur du rappel est ignorée.
   */
  onCheckpoint?: (snapshot: {
    messages: WireMessage[]; turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number;
    cacheWriteTokens: number; costUsd: number | null; costTurnsMissing: number; servedModel: string | null;
  }) => Promise<void>;
}

/**
 * Comment le run s'est terminé. Seul `completed` porte une réponse finale :
 * un tour d'outil, une sortie coupée ou des tours épuisés ne sont pas une
 * réponse à publier (audit 30/10, A5/A6).
 */
export type AgentLoopCompletion = 'completed' | 'max_turns' | 'truncated' | 'cancelled';

/** Relances « continue » autorisées quand la sortie est coupée par la limite de tokens. */
export const MAX_LENGTH_CONTINUATIONS = 2;

export interface AgentLoopResult {
  /**
   * Réponse finale : texte du tour **terminal** (sans appel d'outil, fin
   * normale), suites de sortie coupée comprises. Vide si `completion` n'est
   * pas `completed` — la narration d'un tour d'outil n'est jamais une finale.
   */
  finalText: string;
  completion: AgentLoopCompletion;
  /** La réponse finale vient du tour de synthèse sans outils (lot 13). */
  finalSynthesized: boolean;
  /** Signal d'attente d'une décision humaine (v1.2). */
  waitingForHuman?: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Modèle réellement servi au dernier tour (OmniRoute peut router ailleurs). */
  servedModel: string | null;
  /** En-têtes d'observabilité du dernier tour. */
  gatewayHeaders: Record<string, string>;
  stopReason: string | null;
  /** Coût USD cumulé rapporté par la passerelle ; `null` si aucun tour ne l'a fourni. */
  costUsd: number | null;
  /** Tours dont la passerelle n'a donné aucun coût : la somme est alors un minorant. */
  costTurnsMissing: number;
  /** Provenance comptable du coût : rapporté directement ou calculé via barème officiel. */
  costSource?: 'provider_reported' | 'rate_card';
  /**
   * Fil complet du run, historique de session compris.
   *
   * C'est ce que l'adaptateur écrit dans le fichier de session : au run
   * suivant, il sera rejoué devant le modèle.
   */
  messages: WireMessage[];
  /** Lot 20 — détail de chaque sous-tâche (usage déjà compté dans les totaux). */
  subtasks: SubtaskRecord[];
  /** Lot 20 — escalades effectuées, dans l'ordre. */
  escalations: EscalationRecord[];
  /** Modèle demandé à la dernière tentative (modèle escaladé le cas échéant). */
  finalModel: string;
}

/** Résultat d'une tentative : un passage de boucle sur un modèle. */
interface AttemptResult extends Omit<AgentLoopResult, 'subtasks' | 'escalations' | 'finalModel'> {
  /** Boucle arrêtée sur erreurs d'outil identiques (seulement si une escalade suit). */
  stuck: boolean;
  /** Erreur modèle non récupérée ; l'état partiel ci-dessus reste valable. */
  error?: unknown;
  /** Modèle courant en fin de tentative (repli `fallbackModel` compris). */
  model: string;
}

type CheckpointUsage = Pick<AgentLoopResult,
  'turns' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd' | 'costTurnsMissing'>;

interface AttemptControl {
  /** Arrêter la boucle sur erreurs d'outil identiques ? (vrai seulement si une escalade est possible) */
  stopOnStuck?: (currentModel: string) => boolean;
  /** Usage hors tentative courante, lu au moment du checkpoint uniquement. */
  checkpointOffset?: () => CheckpointUsage;
}

/**
 * Boucle d'agent. Sans réglage du lot 20, c'est exactement une tentative.
 *
 * Avec `subtask`, l'outil `subtask` est ajouté aux outils du modèle principal.
 * Avec `escalationModels`, une tentative qui échoue réellement (pas de finale,
 * boucle bloquée, erreur modèle non récupérable) est reprise sur le modèle
 * suivant de l'échelle, avec l'historique accumulé.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const subtasks: SubtaskRecord[] = [];
  const childUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null as number | null, costTurnsMissing: 0 };

  let tools = options.tools;
  if (options.subtask?.model) {
    const parentTools = options.tools.filter((tool) => tool.spec.name !== SUBTASK_TOOL_NAME);
    tools = [
      ...parentTools,
      buildSubtaskTool({
        settings: options.subtask,
        parentTools,
        parent: {
          maxTokens: options.maxTokens,
          reasoningEffort: options.reasoningEffort,
          sessionId: options.sessionId,
          intraRunBudget: options.intraRunBudget,
          parallelToolCalls: options.parallelToolCalls,
          signal: options.signal,
          emit: options.emit,
          warn: options.warn,
        },
        runChild: async (child): Promise<ChildLoopResult> =>
          runLoopAttempt({ ...child, client: options.client, onProgress: undefined }),
        onRecord: (record, usage) => {
          subtasks.push(record);
          childUsage.inputTokens += usage.inputTokens;
          childUsage.outputTokens += usage.outputTokens;
          childUsage.cacheReadTokens += usage.cacheReadTokens;
          childUsage.cacheWriteTokens += usage.cacheWriteTokens;
          if (typeof usage.costUsd === 'number') childUsage.costUsd = (childUsage.costUsd ?? 0) + usage.costUsd;
          childUsage.costTurnsMissing += usage.costTurnsMissing;
        },
      }),
    ];
  }

  const ladder = (options.escalationModels ?? []).filter((model) => typeof model === 'string' && model.trim().length > 0);
  const maxEscalations = Math.max(0, Math.floor(options.maxEscalations ?? DEFAULT_MAX_ESCALATIONS));
  const escalations: EscalationRecord[] = [];
  const tried = new Set<string>([options.model]);
  const nextRung = (current: string): string | null => {
    if (ladder.length === 0 || escalations.length >= maxEscalations) return null;
    if (options.signal?.aborted) return null;
    const remaining = options.signal ? remainingMs(options.signal) : null;
    if (remaining !== null && remaining < MIN_ESCALATION_REMAINING_MS) return null;
    return nextEscalationModel(ladder, current, tried);
  };

  const attempts: AttemptResult[] = [];
  let attemptOptions: AgentLoopOptions = { ...options, tools };
  for (;;) {
    const attempt = await runLoopAttempt(attemptOptions, {
      stopOnStuck: (model) => nextRung(model) !== null,
      // Lu après les outils : childUsage peut augmenter pendant cette tentative.
      // Les résultats de tentative restent locaux, sinon le total final doublerait l’offset.
      checkpointOffset: () => attempts.reduce<CheckpointUsage>((total, previous) => ({
        turns: total.turns + previous.turns,
        inputTokens: total.inputTokens + previous.inputTokens,
        outputTokens: total.outputTokens + previous.outputTokens,
        cacheReadTokens: total.cacheReadTokens + previous.cacheReadTokens,
        cacheWriteTokens: total.cacheWriteTokens + previous.cacheWriteTokens,
        costTurnsMissing: total.costTurnsMissing + previous.costTurnsMissing,
        costUsd: total.costUsd === null && previous.costUsd === null
          ? null : (total.costUsd ?? 0) + (previous.costUsd ?? 0),
      }), { ...childUsage, turns: 0 }),
    });
    attempts.push(attempt);
    tried.add(attempt.model);

    const reason = escalationReason(attempt);
    const next = reason ? nextRung(attempt.model) : null;
    if (!reason || !next) break;

    const turnsBefore = attempts.reduce((sum, a) => sum + a.turns, 0);
    escalations.push({ from: attempt.model, to: next, reason, turnsBefore });
    tried.add(next);
    const notice = `Escalade : la tentative avec « ${attempt.model} » a échoué (${reason} — ${describeEscalationReason(reason)}) après ${turnsBefore} tour(s) ; reprise sur « ${next} » avec l'historique.`;
    await options.warn(`${notice}\n`);
    await options.emit({ kind: 'system', ts: nowIso(), text: notice });

    attemptOptions = {
      ...options,
      tools,
      model: next,
      history: dropEmptyTrailingAssistant(attempt.messages),
      initialUserMessage: escalationPrompt(attempt.model, reason),
    };
  }

  const last = attempts[attempts.length - 1]!;
  if (last.error !== undefined) throw last.error;

  await options.onProgress?.({
    phase: 'finalize',
    message: `Run terminé après ${attempts.reduce((sum, a) => sum + a.turns, 0)} tour(s)`,
    currentToolName: null,
  });

  let costUsd: number | null = childUsage.costUsd;
  for (const attempt of attempts) {
    if (typeof attempt.costUsd === 'number') costUsd = (costUsd ?? 0) + attempt.costUsd;
  }
  const sum = (key: 'turns' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costTurnsMissing'): number =>
    attempts.reduce((total, attempt) => total + attempt[key], 0);

  return {
    finalText: last.finalText,
    completion: last.completion,
    finalSynthesized: last.finalSynthesized,
    waitingForHuman: last.waitingForHuman,
    turns: sum('turns'),
    inputTokens: sum('inputTokens') + childUsage.inputTokens,
    outputTokens: sum('outputTokens') + childUsage.outputTokens,
    cacheReadTokens: sum('cacheReadTokens') + childUsage.cacheReadTokens,
    cacheWriteTokens: sum('cacheWriteTokens') + childUsage.cacheWriteTokens,
    servedModel: [...attempts].reverse().find((attempt) => attempt.servedModel !== null)?.servedModel ?? null,
    gatewayHeaders: last.gatewayHeaders,
    stopReason: last.stopReason,
    costUsd,
    costTurnsMissing: sum('costTurnsMissing') + childUsage.costTurnsMissing,
    costSource: attempts.some((a) => a.costSource === 'rate_card') ? 'rate_card' : attempts.find((a) => a.costSource)?.costSource,
    messages: last.messages,
    subtasks,
    escalations,
    finalModel: last.model,
  };
}

/** Un tour assistant vide en fin d'historique n'apporte rien et gêne certains fournisseurs. */
function dropEmptyTrailingAssistant(messages: WireMessage[]): WireMessage[] {
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === 'assistant' && !lastMessage.content.some((b) => b.type === 'tool_use' || (b.type === 'text' && b.text.trim().length > 0))) {
    return messages.slice(0, -1);
  }
  return messages;
}

/**
 * Une tentative : la boucle modèle ↔ outils sur un modèle (avec son repli
 * `fallbackModel`). Ne lève pas sur erreur modèle : l'erreur est rendue avec
 * l'état partiel, pour que l'escalade puisse reprendre l'historique.
 */
async function runLoopAttempt(options: AgentLoopOptions, control: AttemptControl = {}): Promise<AttemptResult> {
  const { client, tools, signal, emit } = options;
  const toolByName = new Map(tools.map((tool) => [tool.spec.name, tool]));
  const specs = tools.map((tool) => tool.spec);

  const messages: WireMessage[] = [
    ...(options.history ?? []),
    { role: 'user', content: [{ type: 'text', text: options.initialUserMessage }] },
  ];

  let currentModel = options.model;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let servedModel: string | null = null;
  let gatewayHeaders: Record<string, string> = {};
  let stopReason: string | null = null;
  let finalText = '';
  // Texte d'une sortie coupée (`finish_reason=length`) en attente de sa suite.
  let pendingText = '';
  let continuations = 0;
  let completion: AgentLoopCompletion = 'max_turns';
  let turns = 0;
  let costUsd: number | null = null;
  let costTurnsMissing = 0;
  let costSource: 'provider_reported' | 'rate_card' | undefined;
  let waitingForHuman = false;
  // Lot 20 — détection de boucle bloquée : erreurs d'outil identiques de suite.
  let lastToolError: string | null = null;
  let sameToolErrors = 0;
  let stuck = false;
  let attemptError: unknown;
  const subtaskLimiter = createLimiter(SUBTASK_MAX_PARALLEL);

  // Si maxTurns > 0, on borne le nombre de tours pour respecter la configuration.
  // Si maxTurns <= 0 (défaut, aligné sur claude_local), la boucle tourne jusqu'à
  // complétion naturelle ou expiration du délai (signal/deadline).
  const maxTurnsLimit = options.maxTurns > 0 ? options.maxTurns : Infinity;

  for (let turn = 0; turn < maxTurnsLimit; turn += 1) {
    if (signal?.aborted) {
      completion = 'cancelled';
      break;
    }
    turns += 1;

    let result: ModelCallResult;
    try {
      result = await callModel(
        client,
        options,
        messages,
        specs,
        currentModel,
        (nextModel) => {
          currentModel = nextModel;
        },
      );
    } catch (error) {
      // Rendue avec l'état partiel : l'appelant relance l'erreur telle quelle
      // si aucune escalade n'est possible (comportement inchangé).
      attemptError = error;
      break;
    }

    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    cacheReadTokens += result.usage.cacheReadTokens;
    cacheWriteTokens += result.usage.cacheWriteTokens;
    servedModel = result.servedModel ?? servedModel;
    gatewayHeaders = result.gatewayHeaders;
    stopReason = result.stopReason;
    if (typeof result.costUsd === 'number') {
      costUsd = (costUsd ?? 0) + result.costUsd;
      if (result.costSource === 'rate_card') costSource = 'rate_card';
      else if (!costSource && result.costSource === 'provider_reported') costSource = 'provider_reported';
    } else {
      costTurnsMissing += 1;
    }

    // Les blocs bruts sont réémis au tour suivant à l'identique (signatures
    // de raisonnement comprises).
    messages.push({ role: 'assistant', content: result.content });

    const toolUses = result.content.filter(
      (block): block is Extract<WireContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
    );
    const text = result.content
      .filter((block): block is Extract<WireContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (toolUses.length === 0) {
      if (signal?.aborted) {
        completion = 'cancelled';
        break;
      }
      if (isLengthStop(result.stopReason)) {
        // Sortie coupée par la limite de tokens : on demande la suite plutôt
        // que de publier un texte tronqué. Le texte brut (non rogné) est
        // conservé pour être recollé tel quel.
        pendingText += rawText(result.content);
        if (continuations < MAX_LENGTH_CONTINUATIONS && turn + 1 < maxTurnsLimit) {
          continuations += 1;
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: CONTINUE_PROMPT }],
          });
          continue;
        }
        completion = 'truncated';
        break;
      }
      finalText = (pendingText + rawText(result.content)).trim();
      completion = 'completed';
      break;
    }
    // Un tour d'outil n'est pas une réponse : une éventuelle sortie coupée
    // en attente n'a plus de suite.
    pendingText = '';
    void text;

    // Lot 20 — plusieurs sous-tâches dans un même tour : lancées en parallèle
    // (elles ne font que lire), résultats rangés dans l'ordre des appels.
    const prelaunched = new Map<number, Promise<{ content: string; isError: boolean }>>();
    const subtaskCalls = toolUses.filter((call) => call.name === SUBTASK_TOOL_NAME && toolByName.has(call.name));
    // Mixed batches must remain sequential: an earlier tool may yield for human input.
    if (subtaskCalls.length > 1 && subtaskCalls.length === toolUses.length && !signal?.aborted) {
      toolUses.forEach((call, index) => {
        if (call.name === SUBTASK_TOOL_NAME) prelaunched.set(index, subtaskLimiter(() => executeTool(toolByName, call, emit)));
      });
    }

    const toolResults: WireContentBlock[] = [];
    for (const [index, call] of toolUses.entries()) {
      // Cartes de décision v1.2 : arrêt IMMÉDIAT des outils suivants dans le même tour
      // dès qu'un outil signale une attente humaine, tout en préservant des paires
      // tool_use/tool_result cohérentes pour ne pas corrompre le fil chez les fournisseurs.
      if (waitingForHuman) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: 'Appel non exécuté : passage en attente de décision humaine (in_review).',
        });
        continue;
      }
      const launched = prelaunched.get(index);
      if (launched) {
        const outcome = await launched;
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
        continue;
      }
      // L'interruption peut survenir **pendant** un tour : les outils restants
      // ne sont pas exécutés, mais chacun reçoit un résultat d'annulation.
      // Un `break` ici laissait des appels sans réponse : l'historique rejoué
      // au run suivant était rejeté par les fournisseurs (audit A11).
      if (signal?.aborted) {
        stopReason = 'cancelled';
        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: 'Exécution interrompue : le run a été annulé ou son délai est dépassé.',
          is_error: true,
        });
        continue;
      }
      await options.onProgress?.({
        phase: 'adapter_startup',
        message: `Outil ${call.name} en cours`,
        currentToolName: call.name,
      });
      const outcome = await executeTool(toolByName, call, emit);
      if (outcome.waitingForHuman && !outcome.isError) {
        waitingForHuman = true;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    // Tous les résultats d'un même tour dans un seul message utilisateur :
    // c'est la forme attendue par l'API.
    messages.push({ role: 'user', content: toolResults });

    // Point de contrôle (session + usage) : chaque appel d'outil a sa réponse.
    try {
      const offset = control.checkpointOffset?.();
      await options.onCheckpoint?.({
        messages: [...messages],
        turns: turns + (offset?.turns ?? 0),
        inputTokens: inputTokens + (offset?.inputTokens ?? 0),
        outputTokens: outputTokens + (offset?.outputTokens ?? 0),
        cacheReadTokens: cacheReadTokens + (offset?.cacheReadTokens ?? 0),
        cacheWriteTokens: cacheWriteTokens + (offset?.cacheWriteTokens ?? 0),
        costUsd: costUsd === null && offset?.costUsd == null
          ? null : (costUsd ?? 0) + (offset?.costUsd ?? 0),
        costTurnsMissing: costTurnsMissing + (offset?.costTurnsMissing ?? 0),
        servedModel: servedModel ?? currentModel,
      });
    } catch {
      /* un point de contrôle raté ne fait pas échouer le run */
    }

    // Cartes de décision v1.2 : arrêt immédiat de la boucle (yield) dès l'émission d'une interaction
    if (waitingForHuman) {
      completion = 'completed';
      break;
    }

    // Lot 20 — boucle bloquée : la même erreur d'outil N fois de suite. On ne
    // s'arrête que si une escalade peut reprendre (sinon comportement inchangé).
    for (const [index, block] of toolResults.entries()) {
      if (block.type !== 'tool_result') continue;
      if (block.is_error) {
        const signature = `${toolUses[index]?.name ?? ''}\u0000${block.content}`;
        sameToolErrors = signature === lastToolError ? sameToolErrors + 1 : 1;
        lastToolError = signature;
      } else {
        sameToolErrors = 0;
        lastToolError = null;
      }
    }
    if (sameToolErrors >= STUCK_TOOL_ERROR_THRESHOLD && !signal?.aborted && control.stopOnStuck?.(currentModel)) {
      stuck = true;
      break;
    }

    // Annulation pendant la série d'outils : on ne redemande rien au modèle.
    if (signal?.aborted) {
      stopReason = 'cancelled';
      completion = 'cancelled';
      break;
    }
  }

  // Lot 13 — réponse finale garantie. Mesuré sur 85 runs : 31 « réussis »
  // sans aucun texte final (tours épuisés, ou dernier tour vide). Avant de
  // rendre la main, un dernier tour **sans outils** demande la synthèse ; il
  // n'est pas fait si le run est annulé ou si la sortie est coupée.
  let finalSynthesized = false;
  const needsSynthesis =
    !waitingForHuman &&
    attemptError === undefined &&
    !stuck &&
    !signal?.aborted &&
    (completion === 'max_turns' || (completion === 'completed' && finalText.length === 0));
  if (needsSynthesis) {
    const reason = completion === 'max_turns' ? 'max_turns' : 'empty_final';
    messages.push({ role: 'user', content: [{ type: 'text', text: FINAL_ANSWER_PROMPT }] });
    try {
      const result = await streamOnce(client, options, currentModel, messages, specs, options.reasoningEffort, 'none');
      turns += 1;
      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;
      cacheReadTokens += result.usage.cacheReadTokens;
      cacheWriteTokens += result.usage.cacheWriteTokens;
      servedModel = result.servedModel ?? servedModel;
      gatewayHeaders = result.gatewayHeaders;
      if (typeof result.costUsd === 'number') costUsd = (costUsd ?? 0) + result.costUsd;
      else costTurnsMissing += 1;
      const calledTool = result.content.some((block) => block.type === 'tool_use');
      const text = rawText(result.content).trim();
      if (!calledTool && text.length > 0 && !isLengthStop(result.stopReason)) {
        messages.push({ role: 'assistant', content: result.content });
        finalText = text;
        completion = 'completed';
        stopReason = result.stopReason;
        finalSynthesized = true;
      } else {
        // Appel d'outil malgré l'interdiction, texte vide ou coupé : on retire
        // la demande pour ne pas laisser d'échange incomplet dans l'historique.
        messages.pop();
        await options.warn(`tour de synthèse finale sans réponse exploitable (${reason}).\n`);
      }
    } catch (error) {
      messages.pop();
      await options.warn(`tour de synthèse finale en échec (${reason}) : ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  if (completion === 'max_turns') stopReason = 'max_turns';
  if (completion === 'cancelled') stopReason = 'cancelled';

  return {
    finalText: completion === 'completed' && !waitingForHuman ? finalText : '',
    completion,
    finalSynthesized,
    waitingForHuman,
    turns,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    servedModel,
    gatewayHeaders,
    stopReason,
    costUsd,
    costTurnsMissing,
    costSource,
    messages,
    stuck,
    ...(attemptError !== undefined ? { error: attemptError } : {}),
    model: currentModel,
  };
}

interface ModelCallResult {
  content: WireContentBlock[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  stopReason: string | null;
  servedModel: string | null;
  gatewayHeaders: Record<string, string>;
  costUsd: number | null;
  costSource?: 'provider_reported' | 'rate_card';
}

/**
 * Appelle le modèle en streamant le transcript au fil de l'eau, puis expose la
 * réponse assemblée.
 *
 * `reasoning_effort` n'est pas accepté par tous les fournisseurs qu'OmniRoute
 * agrège : sur un refus explicite, on réessaie une fois en `none` plutôt que
 * de faire échouer le run. C'est un repli, pas une seconde tentative aveugle.
 */
async function callModel(
  client: OmniRouteClient,
  options: AgentLoopOptions,
  messages: WireMessage[],
  specs: WorkspaceTool['spec'][],
  currentModel: string,
  onModelFallback?: (nextModel: string) => void,
): Promise<ModelCallResult> {
  try {
    return await streamOnce(client, options, currentModel, messages, specs, options.reasoningEffort);
  } catch (error) {
    if (
      error instanceof OmniRouteError &&
      isReasoningUnsupported(error) &&
      options.reasoningEffort !== 'none'
    ) {
      await options.warn(
        'reasoning_effort refusé par le fournisseur amont : nouvel essai sans raisonnement étendu.\n',
      );
      return await streamOnce(client, options, currentModel, messages, specs, 'none');
    }

    // Basculement dynamique sur fallbackModel si configuré et différent du modèle courant
    if (
      options.fallbackModel &&
      currentModel !== options.fallbackModel &&
      error instanceof OmniRouteError &&
      (error.classified.retryable ||
        error.status === 503 ||
        error.status === 429 ||
        error.status === 402 ||
        error.status === 404 ||
        error.classified.errorCode === 'omniroute_provider_quota' ||
        error.classified.errorCode === 'model_not_found')
    ) {
      const nextModel = options.fallbackModel;
      await options.warn(
        `modèle « ${currentModel} » indisponible (${error.message}) : bascule sur « ${nextModel} ».\n`,
      );
      onModelFallback?.(nextModel);
      return await streamOnce(client, options, nextModel, messages, specs, options.reasoningEffort);
    }

    throw error;
  }
}

async function streamOnce(
  client: OmniRouteClient,
  options: AgentLoopOptions,
  modelName: string,
  messages: WireMessage[],
  specs: WorkspaceTool['spec'][],
  reasoningEffort: ReasoningEffort,
  toolChoice?: 'auto' | 'none',
): Promise<ModelCallResult> {
  let sawText = false;
  let sawThinking = false;
  let textBuffer = '';

  // Borner l'historique intra-run (A10 + Lot 5) selon le budget résolu
  const outboundMessages = pruneIntraRunHistory(messages, options.intraRunBudget ?? 100_000, options.history?.length ?? 0);

  const result = await client.streamMessage(
    {
      model: modelName,
      parallelToolCalls: options.parallelToolCalls,
      toolChoice,
      system: options.system,
      messages: outboundMessages,
      tools: specs,
      maxTokens: options.maxTokens,
      reasoningEffort,
      cacheControlPoints: options.cacheControlPoints,
      sessionId: options.sessionId,
    },
    {
      onTextDelta: (text) => {
        sawText = true;
        textBuffer += text;
      },
      onThinkingDelta: () => {
        // Le raisonnement est streamé pour l'affichage, mais on ne l'émet
        // qu'une fois complet : le transcript du UI veut un bloc, pas un flot
        // de fragments.
        sawThinking = true;
      },
    },
    options.signal,
  );

  const thinkingText = result.content
    .filter((block): block is Extract<WireContentBlock, { type: 'thinking' }> => block.type === 'thinking')
    .map((block) => block.thinking)
    .join('');

  // Le raisonnement est émis avant le texte : c'est l'ordre dans lequel le
  // modèle l'a produit, et le UI le rend comme un bloc repliable placé avant
  // la réponse.
  if (sawThinking && thinkingText.trim().length > 0) {
    await options.emit({ kind: 'thinking', ts: nowIso(), text: textBuffer.length > 0 ? thinkingText : thinkingText });
  }
  if (sawText && textBuffer.trim().length > 0) {
    await options.emit({ kind: 'assistant', ts: nowIso(), text: textBuffer });
  }

  // Chaque appel d'outil est tracé comme un `tool_call` : le UI le rend en
  // carte repliable et le relie à son résultat par `toolUseId`.
  for (const block of result.content) {
    if (block.type === 'tool_use') {
      await options.emit({
        kind: 'tool_call',
        ts: nowIso(),
        name: block.name,
        input: block.input,
        toolUseId: block.id,
      });
    }
  }

  return {
    content: result.content,
    usage: result.usage,
    stopReason: result.stopReason,
    servedModel: result.model,
    gatewayHeaders: result.gatewayHeaders,
    costUsd: result.costUsd,
    costSource: result.costSource,
  };
}

/** Exécute un appel d'outil et trace son résultat. */
async function executeTool(
  toolByName: Map<string, WorkspaceTool>,
  call: Extract<WireContentBlock, { type: 'tool_use' }>,
  emit: (entry: TranscriptEntry) => Promise<void>,
): Promise<{ content: string; isError: boolean; waitingForHuman?: boolean }> {
  const tool = toolByName.get(call.name);
  let outcome: { content: string; isError: boolean; waitingForHuman?: boolean };

  if (!tool) {
    // Un modèle qui invente un nom d'outil reçoit un refus exploitable plutôt
    // qu'une exception : il peut se corriger au tour suivant.
    const available = [...toolByName.keys()].join(', ');
    outcome = {
      content: `Outil inconnu : « ${call.name} ». Outils disponibles : ${available}.`,
      isError: true,
    };
  } else if (validateToolInput(tool.spec.input_schema, call.input) !== null) {
    // Arguments illisibles ou incomplets : refus AVANT tout effet. Sans cela,
    // `{oops` devenait un `list_dir` par défaut et un `write_file` sans
    // `content` vidait le fichier visé (audit A8).
    outcome = {
      content: `Arguments refusés pour ${call.name} : ${validateToolInput(tool.spec.input_schema, call.input)}. Renvoie l’appel avec des arguments JSON complets.`,
      isError: true,
    };
  } else {
    try {
      outcome = await tool.run(call.input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { content: `Échec de l’outil ${call.name} : ${message}`, isError: true };
    }
  }

  await emit({
    kind: 'tool_result',
    ts: nowIso(),
    toolUseId: call.id,
    content: outcome.content,
    isError: outcome.isError,
  });

  return outcome;
}

/**
 * Validation minimale contre le schéma JSON déclaré par l'outil : objet,
 * champs `required` présents, types primitifs des propriétés connues.
 * Renvoie la raison du refus, ou `null` si l'entrée est acceptable.
 */
export function validateToolInput(schema: unknown, input: unknown): string | null {
  if (input && typeof input === 'object' && !Array.isArray(input) && INVALID_ARGUMENTS_KEY in input
    && Object.keys(input).length === 1) {
    return 'JSON invalide (arguments tronqués ou mal formés)';
  }
  const s = (schema && typeof schema === 'object' ? schema : {}) as {
    type?: unknown; properties?: Record<string, { type?: unknown }>; required?: unknown;
  };
  if (s.type !== 'object') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'un objet JSON est attendu';
  const record = input as Record<string, unknown>;
  const missing = (Array.isArray(s.required) ? s.required : []).filter(
    (key): key is string => typeof key === 'string' && record[key] === undefined,
  );
  if (missing.length > 0) return `champ(s) requis absent(s) : ${missing.join(', ')}`;
  for (const [key, prop] of Object.entries(s.properties ?? {})) {
    const value = record[key];
    if (value === undefined || value === null || typeof prop?.type !== 'string') continue;
    if (!matchesJsonType(prop.type, value)) return `« ${key} » doit être de type ${prop.type}`;
  }
  return null;
}

function matchesJsonType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    // Les modèles envoient souvent les entiers sous forme de chaîne : les outils
    // les convertissent eux-mêmes (`asNumberField`), on ne les refuse donc pas.
    case 'integer': return (typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^\d+$/.test(value));
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}

/** Un 400 mentionnant `thinking` signale un fournisseur qui ne le supporte pas. */
function isReasoningUnsupported(error: OmniRouteError): boolean {
  if (error.status !== 400) return false;
  return /thinking|reasoning/i.test(error.message);
}

/** Message utilisateur qui demande la suite d'une sortie coupée. */
/** Tour de synthèse finale (lot 13) : outils interdits, réponse attendue. */
export const FINAL_ANSWER_PROMPT =
  "Arrête d'utiliser des outils. Donne maintenant ta réponse finale à la demande, en français, " +
  "à partir de ce que tu as déjà fait et appris : ce qui est fait, ce qui reste, les points bloquants. " +
  "Ne décris pas tes prochaines actions, réponds.";

export const CONTINUE_PROMPT =
  'Ta réponse a été coupée par la limite de longueur. Continue exactement là où tu t’es arrêté, sans rien répéter.';

/** `finish_reason` Chat Completions (`length`) ou équivalent Anthropic (`max_tokens`). */
function isLengthStop(stopReason: string | null): boolean {
  return stopReason === 'length' || stopReason === 'max_tokens';
}

/** Texte brut d'un tour (non rogné, pour recoller une suite). */
function rawText(content: WireContentBlock[]): string {
  return content
    .filter((block): block is Extract<WireContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function nowIso(): string {
  return new Date().toISOString();
}
