/**
 * Résolution de la configuration de l'adaptateur OmniRoute.
 *
 * Tout passe par ici, y compris `execute.ts` et `test.ts` : les deux doivent
 * répondre exactement la même chose à la question « où est la passerelle et
 * avec quelle clé ? ». Un diagnostic qui teste une autre URL que celle utilisée
 * à l'exécution ne vaut rien.
 *
 * La clé n'est jamais journalisée ni renvoyée par un diagnostic : on expose
 * `apiKeySource` (d'où elle vient) et `hasApiKey`, jamais sa valeur.
 */

/** Passerelle de l'agence sur Unraid. Surchargeable par config puis par env. */
export const DEFAULT_BASE_URL = process.env['OMNIROUTE_BASE_URL'] ?? 'http://localhost:20128';

/**
 * Modèle par défaut : un combo OmniRoute, pas un modèle de fournisseur.
 * Les combos `auto/*` laissent la passerelle choisir le meilleur modèle
 * disponible pour la tâche, ce qui est exactement la valeur ajoutée
 * d'OmniRoute — coder en dur un `claude-*` reviendrait à ignorer la passerelle.
 */
export const DEFAULT_MODEL = 'auto/best-coding';

/** Au-delà, un run qui bloque encore n'a plus de valeur. */
export const DEFAULT_TIMEOUT_SEC = 900;

export const DEFAULT_MAX_TOKENS = 8192;

/**
 * Nombre maximal d'allers-retours modèle ↔ outils par run.
 *
 * Doit rester aligné sur la valeur par défaut du formulaire de configuration
 * (`config-schema.ts`) : c'est cette valeur qui est affichée à l'utilisateur
 * et qui doit s'appliquer quand la configuration n'en porte pas.
 */
export const DEFAULT_MAX_TURNS = 0; // 0 = illimité, aligné sur claude_local

/**
 * Raisonnement étendu (ACC-2105) : niveau `reasoning_effort` de la surface
 * Chat Completions, pas un budget de tokens Anthropic. `none` = champ omis.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/**
 * Lot 20 — sous-tâches. Tours de la boucle enfant : les runs mesurés
 * (ACC-2305) font ~10 tours presque tous de lecture ; 12 laisse la marge d'une
 * recherche complète sans laisser une sous-tâche tourner en rond.
 */
export const DEFAULT_SUBTASK_MAX_TURNS = 12;
/** Lot 20 — délai propre d'une sous-tâche, borné par le délai restant du run. */
export const DEFAULT_SUBTASK_TIMEOUT_SEC = 300;
/** Lot 20 — escalades par run quand une échelle est configurée. */
/**
 * Lot 21a — 2 : le formulaire propose deux menus d'escalade ; choisir deux
 * modèles suffit à les utiliser tous les deux (l'échelle s'arrête d'elle-même
 * quand il n'y a plus de modèle).
 */
export const DEFAULT_MAX_ESCALATIONS = 2;

export interface OmniRouteConfig {
  baseUrl: string;
  /** `null` quand aucune clé n'est configurée — l'appel échouera proprement. */
  apiKey: string | null;
  /** D'où vient la clé, pour le diagnostic. Jamais la clé elle-même. */
  apiKeySource:
    | 'config'
    | 'env(agent):OMNIROUTE_API_KEY'
    | 'env(agent):ANTHROPIC_API_KEY'
    | 'env:OMNIROUTE_API_KEY'
    | 'env:ANTHROPIC_API_KEY'
    | 'none';
  model: string;
  /** Modèle de repli si le modèle principal est introuvable côté passerelle. */
  fallbackModel: string | null;
  timeoutSec: number;
  maxContextChars?: number;
  maxTokens: number;
  parallelToolCalls?: boolean;
  maxTurns: number;
  reasoningEffort: ReasoningEffort;
  /** Points de cache OmniRoute/MiniMax (`cache_control_points`), JSON ou vide. */
  cacheControlPoints: unknown;
  /** Délai de garde court : c'est un appel réseau interne, pas une inférence. */
  requestTimeoutMs: number;
  /** Lot 20 — modèle des sous-tâches (ex. `AC-task`) ; `null` = outil `subtask` absent. */
  subtaskModel: string | null;
  subtaskMaxTurns: number;
  subtaskTimeoutSec: number;
  /** Lot 20 — échelle d'escalade sur échec réel, dans l'ordre ; vide = pas d'escalade. */
  escalationModels: string[];
  maxEscalations: number;
  /** Outils des plugins Paperclip (`GET /api/plugins/tools`) ; `false` = non exposés. */
  pluginTools: boolean;
}

type RawConfig = Record<string, unknown>;

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Lot 21a — valeur « aucun » des menus facultatifs du formulaire. Le combobox
 * de Paperclip ne sait pas revenir à vide : on propose donc un choix explicite.
 */
export const NO_MODEL = 'aucun';
const NO_MODEL_VALUES = new Set([NO_MODEL, 'none', 'off', 'désactivé', 'desactive']);

/** Modèle choisi dans un menu facultatif ; « aucun » (ou vide) = désactivé. */
export function asModelChoice(value: unknown): string | null {
  const model = asString(value);
  return model && !NO_MODEL_VALUES.has(model.toLowerCase()) ? model : null;
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.max(1, parsed);
  }
  return fallback;
}

function asNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

function asOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.max(1, parsed);
  }
  return undefined;
}

/**
 * Variable de `config.env` de l'agent.
 *
 * Paperclip y résout les `secret_ref` avant l'exécution (chaîne, ou liaison
 * `{ type: 'plain', value }`). Une référence encore non résolue n'est jamais
 * lue : ce n'est pas une clé.
 */
function agentEnvString(config: RawConfig, key: string): string | null {
  const env = config.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  const value = (env as Record<string, unknown>)[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const binding = value as Record<string, unknown>;
    return binding.type === 'plain' ? asString(binding.value) : null;
  }
  return asString(value);
}

/** Retire les `/` de fin : `…/v1` + `/v1/messages` ferait une URL invalide. */
export function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

/**
 * Résout la configuration. Précédence : config explicite → `config.env` de
 * l'agent → variables d'environnement du serveur → défauts de l'agence.
 *
 * `config.env` vient avant le serveur (ACC-3037) : c'est là que Paperclip
 * résout le `secret_ref` de l'agent, et le conteneur `paperclip-ac` ne porte
 * volontairement aucune clé.
 *
 * `ANTHROPIC_API_KEY` est acceptée après `OMNIROUTE_API_KEY` parce que c'est la
 * variable que les instances Paperclip de l'agence positionnent déjà pour
 * router vers OmniRoute : sans ce repli, un agent migré depuis `claude_local`
 * devrait dupliquer sa clé dans la config de l'adaptateur.
 */
/**
 * Une valeur masquée n'est pas une clé utilisable.
 *
 * Paperclip masque les champs secrets dans les réponses de l'API
 * (`***REDACTED***`). Si un champ secret n'est pas déclaré comme tel dans le
 * schéma de l'adaptateur (`meta.secret`), le serveur réinjecte ce masque
 * dans la configuration d'exécution : l'adaptateur l'enverrait alors comme
 * une clé, ce qui ferait échouer l'appel ET masquerait la clé
 * d'environnement valide.
 *
 * On détecte ces masques et on les écarte, pour retomber sur l'environnement.
 */
export function isRedactedValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes('REDACTED')) return true;
  // Masque générique de type `sk-d68...0988` : des points d'ellipse au
  // milieu, ou des astérisques.
  if (trimmed.includes('...')) return true;
  if (/^[^*]*\*[^*]*$/.test(trimmed)) return true;
  return false;
}

export function resolveConfig(config: RawConfig): OmniRouteConfig {
  const configuredApiKey =
    asString(config.apiKey) ?? asString(config.api_key) ?? asString(config.token);
  const keyCandidates: Array<[string | null, OmniRouteConfig['apiKeySource']]> = [
    [configuredApiKey, 'config'],
    [agentEnvString(config, 'OMNIROUTE_API_KEY'), 'env(agent):OMNIROUTE_API_KEY'],
    [agentEnvString(config, 'ANTHROPIC_API_KEY'), 'env(agent):ANTHROPIC_API_KEY'],
    [asString(process.env['OMNIROUTE_API_KEY']), 'env:OMNIROUTE_API_KEY'],
    [asString(process.env['ANTHROPIC_API_KEY']), 'env:ANTHROPIC_API_KEY'],
  ];

  let apiKey: string | null = null;
  let apiKeySource: OmniRouteConfig['apiKeySource'] = 'none';
  // Une valeur masquée n'est pas une clé : c'est le masque que le serveur
  // réinjecte quand un champ secret n'est pas déclaré comme tel dans le
  // schéma de l'adaptateur. L'envoyer à la passerelle ne peut qu'échouer,
  // et surtout cela masque la clé d'environnement valide.
  for (const [candidate, source] of keyCandidates) {
    if (candidate && !isRedactedValue(candidate)) {
      apiKey = candidate;
      apiKeySource = source;
      break;
    }
  }

  const baseUrl = normalizeBaseUrl(
    asString(config.baseUrl) ??
      asString(config.base_url) ??
      agentEnvString(config, 'OMNIROUTE_BASE_URL') ??
      agentEnvString(config, 'ANTHROPIC_BASE_URL') ??
      asString(process.env['OMNIROUTE_BASE_URL']) ??
      asString(process.env['ANTHROPIC_BASE_URL']) ??
      DEFAULT_BASE_URL,
  );

  const timeoutSec = asPositiveInt(config.timeoutSec, DEFAULT_TIMEOUT_SEC);

  return {
    baseUrl,
    apiKey,
    apiKeySource,
    model: asString(config.model) ?? asString(process.env['OMNIROUTE_MODEL']) ?? DEFAULT_MODEL,
    fallbackModel: asModelChoice(config.fallbackModel),
    parallelToolCalls: config.parallelToolCalls === 'false' ? false : config.parallelToolCalls === 'true' || config.parallelToolCalls === true ? true : undefined,
    timeoutSec,
    maxContextChars: asOptionalPositiveInt(config.maxContextChars),
    maxTokens: asPositiveInt(config.maxTokens, DEFAULT_MAX_TOKENS),
    // La valeur par défaut doit être celle du formulaire de configuration
    // (`config-schema.ts`). Avant, le formulaire affichait 8 alors que la
    // résolution runtime retombait sur 1 : un agent ne pouvait donc faire
    // qu'un seul aller-retour modèle ↔ outils, et la boucle d'outils était
    // inopérante en pratique.
    maxTurns: asNonNegativeInt(config.maxTurns, DEFAULT_MAX_TURNS),
    reasoningEffort: asReasoningEffort(config.reasoningEffort) ?? DEFAULT_REASONING_EFFORT,
    cacheControlPoints: parseCacheControlPoints(config.cacheControlPoints),
    // Le budget HTTP d'une requête est aligné sur le run. Il est **borné**
    // ensuite, requête par requête, par le temps restant avant la deadline
    // globale (`client.ts`) : c'est ce qui empêche une boucle de tours de
    // dépasser le budget annoncé.
    //
    // La marge de 15 s laisse à la socket le temps de rendre une erreur
    // propre à la dernière requête quand la deadline tombe juste après.
    requestTimeoutMs: timeoutSec * 1000 + 15_000,
    subtaskModel: asModelChoice(config.subtaskModel),
    subtaskMaxTurns: asPositiveInt(config.subtaskMaxTurns, DEFAULT_SUBTASK_MAX_TURNS),
    subtaskTimeoutSec: asPositiveInt(config.subtaskTimeoutSec, DEFAULT_SUBTASK_TIMEOUT_SEC),
    // Lot 21a — deux menus (escalationModel, escalationModel2), puis l'ancien
    // champ texte à virgules, toujours lu pour les agents déjà configurés.
    // Un choix explicite « aucun » neutralise aussi les valeurs masquées ;
    // un premier menu vide/absent conserve la compatibilité historique.
    escalationModels: NO_MODEL_VALUES.has(asString(config.escalationModel)?.toLowerCase() ?? '') ? [] : parseModelList([
      config.escalationModel,
      config.escalationModel2,
      ...parseModelList(config.escalationModels),
    ]),
    maxEscalations: asNonNegativeInt(config.maxEscalations, DEFAULT_MAX_ESCALATIONS),
    // Activé par défaut : seul un `false` explicite (booléen ou texte) le coupe.
    pluginTools: !(config.pluginTools === false || config.pluginTools === 'false'),
  };
}

/**
 * Liste de modèles : tableau, ou texte séparé par des virgules, points-virgules
 * ou retours à la ligne (champ texte du formulaire). Entrées vides ou non
 * textuelles ignorées, doublons retirés, ordre conservé.
 */
export function parseModelList(value: unknown): string[] {
  const raw: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\n]/) : [];
  const out: string[] = [];
  for (const item of raw) {
    const model = asModelChoice(item);
    if (model && !out.includes(model)) out.push(model);
  }
  return out;
}

function asReasoningEffort(value: unknown): ReasoningEffort | null {
  if (value === 'none' || value === 'low' || value === 'medium' || value === 'high') return value;
  return null;
}

/**
 * `cache_control_points` arrive soit en tableau (déjà structuré), soit en JSON
 * texte depuis le champ `textarea` du formulaire. Toute autre chose est
 * ignorée — mieux vaut un champ absent qu'un corps invalide.
 */
function parseCacheControlPoints(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}
