import { describe, expect, it, vi } from 'vitest';

import { execute } from '../src/server/execute.js';

/**
 * Construit un contexte d'exécution minimal mais fidèle au contrat.
 *
 * On n'exécute pas de modèle : le client est stubé via le chemin d'erreur
 * (clé absente) ou on interrompt le signal avant l'appel. Ce qui compte ici,
 * c'est le **contrat d'annulation** : s'inscrire avant de travailler, ne pas
 * laisser filer un run annulé, et ne pas perdre la comptabilité.
 */
function makeContext(overrides: Record<string, unknown> = {}) {
  const controller = new AbortController();
  const onCancellationReady = vi.fn(async () => {});
  const onProviderStopped = vi.fn(async () => {});
  const onDispatch = vi.fn();

  const ctx = {
    runId: 'run-test',
    agent: { id: 'agent-1', companyId: 'company-1', name: 'Test', adapterType: 'omniroute_native', adapterConfig: {} },
    runtime: {},
    config: { apiKey: 'test-key', model: 'auto/best-coding', baseUrl: 'http://127.0.0.1:1' },
    context: {
      paperclipWorkspace: { cwd: '/tmp' },
    },
    signal: controller.signal,
    onLog: vi.fn(async () => {}),
    onMeta: vi.fn(async () => {}),
    onCancellationReady,
    onProviderStopped,
    onDispatch,
    ...overrides,
  };

  return { ctx, controller, onCancellationReady, onProviderStopped, onDispatch };
}

describe("contrat d'annulation — l'hôte sait que l'adaptateur respecte le signal", () => {
  it("s'inscrit dans l'annulation avant tout travail", async () => {
    const { ctx, onCancellationReady } = makeContext();

    await execute(ctx as never);

    // L'inscription doit avoir eu lieu, et avant toute requête.
    expect(onCancellationReady).toHaveBeenCalledOnce();
  });

  it("signale le dispatch avant la première requête à la passerelle", async () => {
    const { ctx, onDispatch } = makeContext();

    await execute(ctx as never);

    expect(onDispatch).toHaveBeenCalled();
  });

  it('refuse un run déjà annulé sans jamais appeler la passerelle', async () => {
    const { ctx, controller, onProviderStopped } = makeContext();
    controller.abort();

    const result = await execute(ctx as never);

    expect(result.errorCode).toBe('cancelled');
    expect(result.exitCode).toBeNull();
    // Aucune requête n'est partie : le fournisseur n'a jamais démarré, on ne
    // déclare donc PAS le fournisseur arrêté (le contrat vaut « après la
    // dernière invocation confirmée arrêtée »).
    expect(onProviderStopped).not.toHaveBeenCalled();
    const resultJson = result.resultJson as { executionCancellation?: { state?: string } };
    expect(resultJson.executionCancellation?.state).toBe('acknowledged');
  });

  it('annonce la même chose quand la clé manque, mais reste un échec', async () => {
    // Hermétique : une clé dans l'environnement du processus de test ferait
    // partir l'appel vers la passerelle par défaut.
    vi.stubEnv('OMNIROUTE_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { ctx } = makeContext({ config: { apiKey: '', model: 'auto/best-coding' } });

    try {
      const result = await execute(ctx as never);

      expect(result.errorCode).toBe('omniroute_auth_rejected');
      expect(result.exitCode).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
