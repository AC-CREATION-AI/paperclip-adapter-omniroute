/**
 * Budget de contexte d'un run (ACC-3085).
 *
 * Aucune fenêtre n'est écrite à la main : elle est lue à OmniRoute au début
 * du run, pour le modèle demandé ET son `fallbackModel` (le repli peut
 * reprendre la conversation en cours, il doit donc la contenir). Le budget est
 * le plus petit des deux. Une fenêtre inconnue ou une passerelle muette donne
 * le repli prudent de 200 000 tokens, jamais une valeur optimiste.
 *
 * Lecture par `GET /v1/models/{id}` plutôt que la liste complète : mêmes
 * champs, mais la liste pèse ≈ 9 Mo et met ≈ 5 s (mesuré le 07/11/2026).
 */
import { createHash } from 'node:crypto';

/** Repli prudent : OmniRoute injoignable ou fenêtre inconnue. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
/** Durée de vie d'un budget lu à OmniRoute. */
export const CONTEXT_BUDGET_TTL_MS = 10 * 60 * 1_000;
// La fiche par modèle met 4,4 à 5,3 s quand le catalogue se reconstruit (mesuré le 07/11/2026).
const DISCOVERY_TIMEOUT_MS = 10_000;

/** Origine des seuils appliqués au run. */
export type ContextBudgetSource = 'omniroute:/v1/models' | 'config' | 'défaut';

export interface ContextBudgetModel {
  id: string;
  /** Fenêtre d'entrée lue, `null` si inconnue. */
  tokens: number | null;
  maxOutputTokens: number | null;
}

export interface ContextBudget {
  /** Fenêtre retenue (tokens) : minimum des modèles, borné par le repli prudent si l'un est inconnu. */
  tokens: number;
  /** Plus petite sortie maximale connue, `null` si aucune. */
  maxOutputTokens: number | null;
  source: ContextBudgetSource;
  models: ContextBudgetModel[];
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function minOf(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length > 0 ? Math.min(...known) : null;
}

/**
 * Fenêtre d'une fiche OmniRoute : `context_length` (ou `advertisedContextLength`
 * des combos), bornée par `max_input_tokens` quand la passerelle admet moins
 * en entrée (AC-free : 256 000 annoncés, 42 000 admis).
 */
function entryOf(models: readonly unknown[], id: string): ContextBudgetModel {
  const entry = models.find(
    (m): m is Record<string, unknown> => typeof m === 'object' && m !== null && (m as Record<string, unknown>)['id'] === id,
  );
  if (!entry) return { id, tokens: null, maxOutputTokens: null };
  const window = positiveInt(entry['context_length']) ?? positiveInt(entry['advertisedContextLength']);
  return {
    id,
    tokens: minOf([window, positiveInt(entry['max_input_tokens'])]),
    maxOutputTokens: positiveInt(entry['max_output_tokens']),
  };
}

/**
 * Budget de contexte pour `model` et son repli, d'après des fiches
 * `/v1/models` (`null` : passerelle injoignable). Fonction pure.
 */
export function resolveContextBudget(
  models: readonly unknown[] | null | undefined,
  model: string,
  fallback?: string | null,
): ContextBudget {
  const ids = [model, ...(fallback && fallback !== model ? [fallback] : [])];
  const entries = ids.map((id) => entryOf(models ?? [], id));
  const allKnown = entries.every((e) => e.tokens !== null);
  const known = minOf(entries.map((e) => e.tokens));
  return {
    tokens: allKnown && known !== null ? known : Math.min(known ?? DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_CONTEXT_WINDOW_TOKENS),
    maxOutputTokens: minOf(entries.map((e) => e.maxOutputTokens)),
    source: allKnown ? 'omniroute:/v1/models' : 'défaut',
    models: entries,
  };
}

const budgetCache = new Map<string, { budget: ContextBudget; expiresAt: number }>();

/** Réinitialise le cache (tests). */
export function clearContextBudgetCache(): void {
  budgetCache.clear();
}

export interface LoadContextBudgetOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackModel?: string | null;
  signal?: AbortSignal;
}

/**
 * Lit les fiches du modèle et du repli à OmniRoute, puis résout le budget.
 * Seul un budget lu à OmniRoute est mis en cache (10 min, par passerelle, clé
 * hachée, modèle et repli) : après un échec, le run suivant relit.
 */
export async function loadContextBudget(options: LoadContextBudgetOptions): Promise<ContextBudget> {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const key = createHash('sha256')
    .update(JSON.stringify([baseUrl, options.apiKey, options.model, options.fallbackModel ?? null]))
    .digest('hex');
  const hit = budgetCache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.budget;

  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const ids = [...new Set([options.model, options.fallbackModel].filter((id): id is string => !!id))];
  const entries = await Promise.all(ids.map(async (id) => {
    try {
      const response = await fetch(`${baseUrl}/v1/models/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          accept: 'application/json',
          'User-Agent': 'omniroute-native/1.0 (sdk-cli; Paperclip-Agent)',
        },
        signal,
      });
      return response.ok ? ((await response.json()) as unknown) : null;
    } catch {
      return null;
    }
  }));

  const budget = resolveContextBudget(entries.filter((e) => e !== null), options.model, options.fallbackModel);
  if (budget.source === 'omniroute:/v1/models') {
    budgetCache.set(key, { budget, expiresAt: Date.now() + CONTEXT_BUDGET_TTL_MS });
  }
  return budget;
}
