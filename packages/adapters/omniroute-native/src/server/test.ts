/**
 * Test d'environnement : les vérifications que le board affiche avant
 * d'autoriser un run.
 *
 * Trois niveaux, et la distinction compte :
 * - `info` : constat, ne bloque rien.
 * - `warn` : ça peut marcher, l'opérateur devrait regarder.
 * - `error` : **bloque l'exécution**. On ne pose un `error` que sur une cause
 *   qu'on a réellement constatée, jamais sur une supposition.
 *
 * La clé d'API n'est jamais renvoyée ni journalisée : on expose sa *source*
 * (`config`, `env:…`, `none`), ce qui suffit à diagnostiquer sans fuiter.
 */
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from '@paperclipai/adapter-utils';

import { OmniRouteClient, OmniRouteError } from '../shared/client.js';
import { resolveConfig } from '../shared/config.js';

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = resolveConfig(ctx.config ?? {});

  checks.push({
    code: 'base_url',
    level: 'info',
    message: `Passerelle ciblée : ${config.baseUrl}`,
    detail: `Modèle demandé : ${config.model}`,
  });

  if (!config.apiKey) {
    checks.push({
      code: 'missing_api_key',
      level: 'error',
      message: 'Aucune clé d’API OmniRoute',
      detail:
        'Ni `apiKey` dans la config, ni OMNIROUTE_API_KEY / ANTHROPIC_API_KEY dans les variables de l’agent (`env`) ou du serveur ne sont définis.',
      hint:
        'Liez un secret à ANTHROPIC_API_KEY (ou OMNIROUTE_API_KEY) dans les variables d’environnement de l’agent, ou renseignez `apiKey` dans la configuration de l’adaptateur. OmniRoute exige `Authorization: Bearer` : une clé passée en `x-api-key` est refusée avec un 401.',
    });
    return result(checks);
  }

  checks.push({
    code: 'api_key',
    level: 'info',
    message: 'Clé d’API présente',
    detail: `Source : ${config.apiKeySource}`,
  });

  const client = new OmniRouteClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    requestTimeoutMs: Math.min(config.requestTimeoutMs, 30_000),
  });

  let available: string[] | null = null;
  try {
    available = await client.listModels();
    checks.push({
      code: 'reachable',
      level: 'info',
      message: `Passerelle joignable — ${available.length} modèles exposés`,
    });
  } catch (error) {
    const classified = error instanceof OmniRouteError ? error.classified : null;
    checks.push({
      code: classified?.errorCode ?? 'unreachable',
      // Une panne d'admission est transitoire : elle ne doit pas bloquer la
      // configuration, seulement avertir. En revanche un refus d'identifiants
      // ou une URL injoignable sont définitifs.
      level: classified?.retryable ? 'warn' : 'error',
      message: 'Passerelle OmniRoute non joignable',
      detail:
        classified?.summary ??
        (error instanceof Error ? error.message : String(error)),
      hint: 'Vérifiez l’URL, que le conteneur OmniRoute tourne, et que le processus Paperclip peut l’atteindre sur le réseau.',
    });
    return result(checks);
  }

  // La comparaison tolère les deux formes d'identifiant. Relevé live sur
  // l'instance de l'agence : `/v1/models` renvoie 3106 identifiants *avec*
  // préfixe de fournisseur (`agy/gemini-3.7-flash-medium`), 38 combos `auto/*`,
  // et 11 identifiants nus (`AC-local-code`). Comme les deux formes coexistent
  // et que le préfixe peut différer d'un alias à l'autre, on accepte
  // l'égalité stricte, la forme suffixée et la forme préfixée.
  if (available.length > 0) {
    const wanted = config.model;
    const matched = available.some(
      (id) => id === wanted || id.endsWith(`/${wanted}`) || wanted.endsWith(`/${id}`),
    );
    if (matched) {
      checks.push({
        code: 'model_available',
        level: 'info',
        message: `Modèle disponible : ${wanted}`,
      });
    } else if (config.fallbackModel) {
      checks.push({
        code: 'model_fallback',
        level: 'warn',
        message: `Modèle « ${wanted} » introuvable — repli configuré sur « ${config.fallbackModel} »`,
        hint: 'Choisissez un modèle dans la liste exposée par la passerelle pour éviter le repli.',
      });
    } else {
      checks.push({
        code: 'model_not_found',
        level: 'warn',
        message: `Modèle « ${wanted} » introuvable côté passerelle et aucun repli configuré`,
        detail: `Exemples exposés : ${available.slice(0, 8).join(', ')}`,
        hint: 'Un modèle inconnu fera échouer les runs. Renseignez `model` avec un identifiant exposé, ou configurez `fallbackModel`.',
      });
    }
  }

  return result(checks);
}

function result(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult {
  const hasError = checks.some((check) => check.level === 'error');
  const hasWarn = checks.some((check) => check.level === 'warn');
  return {
    adapterType: 'omniroute_native',
    status: hasError ? 'fail' : hasWarn ? 'warn' : 'pass',
    checks,
    testedAt: new Date().toISOString(),
  };
}
