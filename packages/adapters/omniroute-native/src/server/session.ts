/**
 * Continuité de session — la partie la plus discrète du contrat Paperclip.
 *
 * OmniRoute est **sans état côté fournisseur** : `POST /v1/chat/completions`
 * ne connaît aucune session. Une session Paperclip, elle, existe : le serveur
 * persiste des `sessionParams` par tâche et les redonne à l'adaptateur dans
 * `ctx.runtime.sessionParams`.
 *
 * Sans travail de notre côté, cette session ne servirait à rien : l'agent
 * repartirait de zéro à chaque run, et Paperclip afficherait « session
 * reprise » alors que le modèle ne se souvient de rien.
 *
 * La continuité se fait donc **côté adaptateur**, par un fichier :
 *
 *   <répertoire de session>/<id de session>.json
 *
 * qui contient l'historique des messages (utilisateur, assistant, appels
 * d'outils et leurs résultats). Au run suivant, l'historique est rejoué dans
 * la requête — c'est le seul moyen de parler à une API sans session.
 *
 * Deux invariants :
 *
 * 1. **Le fichier est écrit par l'adaptateur, jamais par le modèle**, et il
 *    ne contient aucun secret : tout est masqué avant l'écriture (et chaque
 *    sortie d'outil l'est déjà avant d'entrer dans l'historique). Fichier
 *    `0600`, dossier `0700` avec `.gitignore` « * », écriture atomique sous
 *    verrou, purge après 14 jours (voir `session-store.ts`). Le dossier peut
 *    se trouver dans le workspace quand le home de l'agent en est un : d'où
 *    le masquage et les droits, plutôt qu'une confiance dans l'emplacement.
 * 2. **L'historique est borné.** Rejouer tout l'historique à chaque tour
 *    ferait croître le coût quadratiquement et finirait par dépasser le
 *    contexte du fournisseur. On garde donc les messages les plus récents
 *    dans un budget de caractères.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { WireMessage } from '../shared/wire.js';
import { calculateDynamicSessionBudgets } from '../shared/context-window.js';
import { CONTINUE_PROMPT, FINAL_ANSWER_PROMPT } from './agent-loop.js';
import { redactSecrets, redactWireMessages } from './secrets-redact.js';
import { ensurePrivateDir, isCompatibleSessionEnvelope, withSessionLock, writeFileAtomic, type LockOptions } from './session-store.js';

/** Marqueur porté par nos `sessionParams` : distingue nos sessions d'autres. */
export const SESSION_MARKER_KEY = 'omnirouteNativeSession';

/**
 * Budget de caractères de l'historique rejoué.
 *
 * Un tour de récapitulation représente couramment 2 000 à 8 000 caractères.
 * À 40 000 caractères, on rejoue une dizaine de tours : assez pour que le
 * modèle se souvienne du travail en cours, assez peu pour que le coût reste
 * linéaire. Au-delà, l'historique est tronqué **par le plus ancien** — on
 * garde la fin, qui est ce qui est en train de se passer.
 */
export const DEFAULT_MIN_HISTORY_CHAR_BUDGET = 100_000;
export const DEFAULT_MAX_HISTORY_CHAR_BUDGET = 400_000;
export const DEFAULT_HISTORY_CHAR_BUDGET = DEFAULT_MIN_HISTORY_CHAR_BUDGET;

export const DEFAULT_MIN_INTRARUN_CHAR_BUDGET = 100_000;
export const DEFAULT_MAX_INTRARUN_CHAR_BUDGET = 600_000;

/**
 * Calcule dynamiquement le budget d'historique de session (en caractères)
 * selon la capacité de contexte du modèle (audit opportunité 3).
 */
export function resolveHistoryBudgetChars(
  model: string,
  modelContextTokens?: number,
  userBudgetChars?: number,
): number {
  if (typeof userBudgetChars === 'number' && Number.isFinite(userBudgetChars) && userBudgetChars > 0) {
    return Math.floor(userBudgetChars);
  }
  if (typeof modelContextTokens === 'number' && Number.isFinite(modelContextTokens) && modelContextTokens > 0) {
    return calculateDynamicSessionBudgets(modelContextTokens).historyBudgetChars;
  }
  return DEFAULT_MIN_HISTORY_CHAR_BUDGET;
}

/**
 * Calcule dynamiquement le budget intra-run (en caractères)
 * selon la capacité de contexte du modèle (audit A10).
 */
export function resolveIntraRunBudgetChars(
  model: string,
  modelContextTokens?: number,
  userBudgetChars?: number,
): number {
  if (typeof userBudgetChars === 'number' && Number.isFinite(userBudgetChars) && userBudgetChars > 0) {
    return Math.floor(userBudgetChars);
  }
  if (typeof modelContextTokens === 'number' && Number.isFinite(modelContextTokens) && modelContextTokens > 0) {
    return calculateDynamicSessionBudgets(modelContextTokens).intraRunBudgetChars;
  }
  return DEFAULT_MIN_INTRARUN_CHAR_BUDGET;
}

/** Nos `sessionParams` : un identifiant de session et notre marqueur. */
export interface OmniRouteSessionParams extends Record<string, unknown> {
  sessionId: string;
  [SESSION_MARKER_KEY]: true;
}

/**
 * Extrait nos `sessionParams` du contexte d'exécution.
 *
 * Le serveur peut nous remettre des `sessionParams` qui ne sont pas les
 * nôtres (adaptateur changé, session d'un autre agent) : on ne reprend que
 * ceux qui portent notre marqueur, sinon on repartirait d'une session
 * inconnue.
 */
export function readOmniRouteSessionParams(
  runtime: { sessionParams?: Record<string, unknown> | null } | undefined,
): OmniRouteSessionParams | null {
  const params = runtime?.sessionParams;
  if (!params || typeof params !== 'object') return null;
  if (params[SESSION_MARKER_KEY] !== true) return null;
  const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'].trim() : '';
  if (sessionId.length === 0) return null;
  return { sessionId, [SESSION_MARKER_KEY]: true };
}

/** Crée les `sessionParams` d'une nouvelle session. */
export function createOmniRouteSessionParams(): OmniRouteSessionParams {
  return { sessionId: randomUUID(), [SESSION_MARKER_KEY]: true };
}

/**
 * Répertoire de stockage des historiques.
 *
 * Il doit être **stable d'un run à l'autre** pour un agent donné, sinon la
 * continuité est perdue. Mesuré en production : quand Paperclip prépare une
 * copie de travail des instructions, il remplace `agentHome` par la copie du
 * run (`…/file-sync/runs/<run>/live`, nouvelle à chaque run) et garde le
 * vrai home dans `agentHomeForPermissions` (`heartbeat.ts:4417-4420`).
 *
 * Ordre de préférence :
 * 1. `agentHomeForPermissions` (le home stable quand une copie existe) ;
 * 2. `agentHome`, sauf s'il désigne une copie propre à un run ;
 * 3. à défaut, le workspace du run (le dossier porte un `.gitignore` « * »
 *    pour ne jamais polluer un dépôt).
 */
const RUN_SCOPED_DIR = /[\\/]file-sync[\\/]runs[\\/]/;

export type SessionStorageSource = 'agent_home_for_permissions' | 'agent_home' | 'workspace';

export function resolveSessionStorage(
  context: Record<string, unknown> | undefined,
  workspaceCwd: string,
): { baseDir: string; source: SessionStorageSource } {
  const workspace = context?.['paperclipWorkspace'];
  const record = workspace && typeof workspace === 'object' ? (workspace as Record<string, unknown>) : {};
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const stableHome = text(record['agentHomeForPermissions']);
  const home = text(record['agentHome']);
  if (stableHome && !RUN_SCOPED_DIR.test(stableHome)) {
    return { baseDir: path.join(stableHome, '.omniroute-sessions'), source: 'agent_home_for_permissions' };
  }
  if (home && !RUN_SCOPED_DIR.test(home)) {
    return { baseDir: path.join(home, '.omniroute-sessions'), source: 'agent_home' };
  }
  return { baseDir: path.join(workspaceCwd, '.omniroute-sessions'), source: 'workspace' };
}

export function resolveSessionBaseDir(
  context: Record<string, unknown> | undefined,
  workspaceCwd: string,
): string {
  return resolveSessionStorage(context, workspaceCwd).baseDir;
}

/** Chemin du fichier d'historique d'une session. */
export function sessionFilePath(baseDir: string, sessionId: string): string {
  // Un identifiant de session ne doit jamais pouvoir sortir du répertoire :
  // on ne garde que les caractères alphanumériques et le tiret. Les points
  // sont retirés aussi : `..` deviendrait `__`, et un nom de fichier sans
  // point ne peut pas désigner un répertoire parent.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(baseDir, `${safe}.json`);
}

interface StoredSession {
  version: 1;
  sessionId: string;
  updatedAt: string;
  messages: WireMessage[];
}

export type SessionLoadStatus = 'missing' | 'ok' | 'corrupt';

/** État interne distinct pour interdire aussi l'écrasement d'un format incompatible. */
type SessionFileState = { messages: WireMessage[]; status: SessionLoadStatus | 'incompatible' };

/** Lit et valide un fichier de session (sans verrou ni masquage). */
async function readSessionFile(file: string, sessionId: string): Promise<SessionFileState> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    return { messages: [], status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt' };
  }
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { messages: [], status: 'corrupt' };
    // Tous nos écrivains historiques portent version:1 et l'ID logique exact.
    // Pas de migration implicite : ni les versions inconnues/non versionnées,
    // ni une collision de nom assaini ne doivent rejouer un autre checkpoint.
    if (!isCompatibleSessionEnvelope(parsed, sessionId)) return { messages: [], status: 'incompatible' };
    if (!Array.isArray(parsed.messages)) return { messages: [], status: 'corrupt' };
    // Validation profonde : un fichier JSON valide peut contenir des blocs
    // corrompus (`content: [null]`) qui faisaient lever trimSessionMessages
    // avant le try principal du run (audit A9). Un bloc invalide est écarté,
    // un message sans bloc valide aussi.
    const out: WireMessage[] = [];
    for (const candidate of parsed.messages) {
      if (!isWireMessage(candidate)) continue;
      const content = (candidate.content as unknown[]).filter(isWireBlock);
      if (content.length > 0) out.push({ role: candidate.role, content } as WireMessage);
    }
    return { messages: out, status: 'ok' };
  } catch {
    return { messages: [], status: 'corrupt' };
  }
}

/**
 * Charge l'historique d'une session, **masqué** (un ancien fichier peut
 * contenir un secret écrit avant le masquage), avec son état : `corrupt`
 * signale un fichier tronqué, illisible ou d'enveloppe incompatible. Seuls
 * version:1 et l'ID logique concordant sont repris ; aucun fichier n'est
 * migré à la lecture. Un écrivain refuse aussi l'enveloppe incompatible.
 */
export async function loadSessionState(
  baseDir: string,
  sessionId: string,
  redact: (text: string) => string = (text) => redactSecrets(text),
): Promise<{ messages: WireMessage[]; status: SessionLoadStatus }> {
  const state = await readSessionFile(sessionFilePath(baseDir, sessionId), sessionId);
  // Conserve l'avertissement `corrupt` des appelants, sans exposer l'historique.
  return { messages: redactWireMessages(state.messages, redact), status: state.status === 'incompatible' ? 'corrupt' : state.status };
}

/** Charge l'historique d'une session. Un fichier absent ou illisible = aucun historique. */
export async function loadSessionMessages(baseDir: string, sessionId: string): Promise<WireMessage[]> {
  return (await loadSessionState(baseDir, sessionId)).messages;
}

export interface SessionWriteOptions {
  /** Masqueur (valeurs connues du run) ; par défaut, motifs seuls. */
  redact?: (text: string) => string;
  lock?: LockOptions;
}

/**
 * Réécrit un fichier de session sous verrou, de façon atomique, en `0600`
 * dans un dossier `0700` porteur d'un `.gitignore`. `build` reçoit
 * l'historique présent sur le disque **sous verrou** et rend le nouveau.
 * Renvoie l'erreur rencontrée, ou `null` : une sauvegarde ratée n'échoue
 * jamais le run, mais elle doit pouvoir être signalée.
 */
async function updateSessionFile(
  baseDir: string,
  sessionId: string,
  build: (disk: WireMessage[]) => WireMessage[],
  options: SessionWriteOptions = {},
): Promise<string | null> {
  try {
    await ensurePrivateDir(baseDir);
    const file = sessionFilePath(baseDir, sessionId);
    await withSessionLock(
      file,
      async () => {
        const state = await readSessionFile(file, sessionId);
        // La relecture sous verrou protège aussi les écritures directes et un
        // fichier remplacé après l'ouverture du run. Ne pas perdre la source.
        if (state.status === 'incompatible') throw new Error('fichier de session incompatible : version ou identité discordante ; source conservée');
        const disk = state.messages;
        const payload: StoredSession = {
          version: 1,
          sessionId,
          updatedAt: new Date().toISOString(),
          messages: redactWireMessages(build(disk), options.redact ?? ((text) => redactSecrets(text))),
        };
        await writeFileAtomic(file, JSON.stringify(payload));
      },
      options.lock,
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Écrit (remplace) l'historique d'une session. Une erreur d'écriture n'échoue pas le run. */
export async function saveSessionMessages(
  baseDir: string,
  sessionId: string,
  messages: WireMessage[],
  options: SessionWriteOptions = {},
): Promise<boolean> {
  return (await updateSessionFile(baseDir, sessionId, () => messages, options)) === null;
}

export interface SessionWriterOptions extends SessionWriteOptions {
  baseDir: string;
  sessionId: string;
  /** Nombre de messages d'historique rejoués en tête du fil du run. */
  historyLength: number;
  /** Budget de rognage du fichier (caractères). */
  budget?: number;
}

/**
 * Écrivain de session d'un run : points de contrôle et sauvegarde finale.
 *
 * Il n'écrit que **ce que ce run a ajouté** depuis sa dernière écriture, à la
 * suite de ce qui est sur le disque au moment de l'écriture (sous verrou).
 * Deux runs concurrents sur la même session gardent donc chacun leurs
 * échanges au lieu de s'écraser, et des points de contrôle successifs ne
 * dupliquent rien.
 */
export class SessionWriter {
  private persisted = 0;
  lastError: string | null = null;

  constructor(private readonly options: SessionWriterOptions) {}

  get sessionId(): string {
    return this.options.sessionId;
  }

  get baseDir(): string {
    return this.options.baseDir;
  }

  /** Un point de contrôle ou la sauvegarde finale a-t-il réussi au moins une fois ? */
  get hasSaved(): boolean {
    return this.persisted > 0;
  }

  /** `messages` : fil complet du run (historique rejoué compris). */
  async save(messages: WireMessage[]): Promise<boolean> {
    const fresh = messages.slice(this.options.historyLength);
    const pending = fresh.slice(this.persisted);
    if (pending.length === 0 && this.persisted > 0) return true;
    const budget = this.options.budget;
    const error = await updateSessionFile(
      this.options.baseDir,
      this.options.sessionId,
      (disk) => {
        const merged = [...disk, ...pending];
        return budget ? trimSessionMessages(merged, budget) : merged;
      },
      this.options,
    );
    this.lastError = error;
    if (error !== null) return false;
    this.persisted = fresh.length;
    return true;
  }
}

/** Supprime le fichier d'une session (historique refusé par le modèle). */
export async function deleteSessionFile(baseDir: string, sessionId: string): Promise<void> {
  const file = sessionFilePath(baseDir, sessionId);
  await withSessionLock(file, () => fs.rm(file, { force: true }), { timeoutMs: 1_000 }).catch(() => undefined);
}

/**
 * Borne l'historique rejoué.
 *
 * On garde les messages **les plus récents** jusqu'à épuisement du budget.
 * L'historique ancien est le moins utile : il décrit un état du workspace
 * qui a déjà changé.
 */
export function trimSessionMessages(
  messages: WireMessage[],
  budget: number = DEFAULT_HISTORY_CHAR_BUDGET,
): WireMessage[] {
  // On rogne par **échanges** complets : un échange commence à un message
  // utilisateur qui n'est pas une réponse d'outil (une vraie consigne) et
  // court jusqu'à la consigne suivante. Couper au message près pouvait garder
  // un `tool_result` sans son `tool_use`, historique que les fournisseurs
  // rejettent (audit A4). Le dernier échange est toujours gardé.
  const exchanges: WireMessage[][] = [];
  for (const message of messages) {
    if (isPromptMessage(message) || exchanges.length === 0) exchanges.push([message]);
    else exchanges[exchanges.length - 1]!.push(message);
  }
  let total = 0;
  const kept: WireMessage[][] = [];
  for (let i = exchanges.length - 1; i >= 0; i -= 1) {
    const exchange = exchanges[i]!;
    const size = exchange.reduce((sum, message) => sum + messageSize(message), 0);
    if (kept.length > 0 && total + size > budget) break;
    total += size;
    kept.unshift(exchange);
  }
  return dropOrphanToolResults(kept.flat());
}

/**
 * Consigne utilisateur : message `user` qui ne contient aucune réponse
 * d'outil. Les relances internes de la boucle (« continue », « réponse
 * finale ») ne sont **pas** des consignes : elles prolongent l'échange de la
 * tâche courante. Les compter comme consignes faisait rogner la tâche et
 * garder une relance orpheline (« Arrête d'utiliser des outils… »).
 */
function isPromptMessage(message: WireMessage): boolean {
  if (message.role !== 'user') return false;
  if (message.content.some((block) => block.type === 'tool_result')) return false;
  const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  return text !== CONTINUE_PROMPT && text !== FINAL_ANSWER_PROMPT;
}

/**
 * Filet de sécurité : retire un historique de tête qui ne commence pas par une
 * consigne, et tout `tool_result` dont l'appel n'est pas dans l'historique.
 */
function dropOrphanToolResults(messages: WireMessage[]): WireMessage[] {
  const start = messages.findIndex(isPromptMessage);
  const head = start < 0 ? [] : messages.slice(start);
  const calls = new Set<string>();
  const out: WireMessage[] = [];
  for (const message of head) {
    for (const block of message.content) if (block.type === 'tool_use') calls.add(block.id);
    const content = message.content.filter((block) => block.type !== 'tool_result' || calls.has(block.tool_use_id));
    if (content.length > 0) out.push({ ...message, content });
  }
  return out;
}

/** Taille approximative d'un message, en caractères. */
function messageSize(message: WireMessage): number {
  let size = 0;
  for (const block of message.content) {
    if (block.type === 'text') size += block.text.length;
    else if (block.type === 'thinking') size += block.thinking.length;
    else if (block.type === 'tool_use') size += block.name.length + JSON.stringify(block.input ?? {}).length;
    else if (block.type === 'tool_result') size += block.content.length;
  }
  return size;
}

/** Un bloc rechargé doit avoir les champs que la boucle et le convertisseur lisent. */
function isWireBlock(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  switch (b['type']) {
    case 'text': return typeof b['text'] === 'string';
    case 'thinking': return typeof b['thinking'] === 'string';
    case 'tool_use': return typeof b['id'] === 'string' && typeof b['name'] === 'string';
    case 'tool_result': return typeof b['tool_use_id'] === 'string' && typeof b['content'] === 'string';
    default: return false;
  }
}

/** Un message rechargé depuis le disque doit avoir la forme attendue. */
function isWireMessage(value: unknown): value is WireMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { role?: unknown; content?: unknown };
  if (candidate.role !== 'user' && candidate.role !== 'assistant') return false;
  return Array.isArray(candidate.content);
}
