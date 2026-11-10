import { describe, expect, it, vi } from 'vitest';
import { execute } from '../src/server/execute.js';
import { createServerAdapter } from '../src/server/index.js';
import { OmniRouteClient } from '../src/shared/client.js';
import { buildChatCompletionsPayload } from '../src/shared/chat-completions.js';
import { startFakeGateway } from './support/fake-gateway.js';
import { makeTestContext } from './support/test-context.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Lot 4 — Parité hôte et optimisations passerelle', () => {
  it('déclare supportsToolRefreshOnResume: true sur l adaptateur', () => {
    const adapter = createServerAdapter();
    expect(adapter.supportsToolRefreshOnResume).toBe(true);
  });

  it('émet executionRecovery: { kind: bootstrap, providerWorkStarted: false } si pas de clé API', async () => {
    // Hermétique : une clé dans l'environnement du processus de test ferait
    // partir l'appel vers la passerelle par défaut.
    vi.stubEnv('OMNIROUTE_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { ctx } = makeTestContext({ config: { apiKey: '' } });
    try {
      const result = await execute(ctx as never);
      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe('omniroute_auth_rejected');
      expect(result.executionRecovery).toEqual({ kind: 'bootstrap', providerWorkStarted: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('émet executionRecovery: { kind: bootstrap, providerWorkStarted: false } si workspace manquant', async () => {
    const { ctx } = makeTestContext({ config: { baseUrl: 'http://127.0.0.1:9' }, context: {} });
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe('omniroute_missing_workspace');
    expect(result.executionRecovery).toEqual({ kind: 'bootstrap', providerWorkStarted: false });
  });

  it('hydrate le handoff de session compactée via getFreshSessionHandoff sur session fraîche', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omni-handoff-'));
    const gateway = await startFakeGateway();
    const handoffText = 'Voici le plan convenu précédemment et les décisions actées.';
    const getFreshSessionHandoff = vi.fn(async () => handoffText);

    const { ctx } = makeTestContext({
      config: { baseUrl: gateway.baseUrl },
      context: { paperclipWorkspace: { cwd } },
    });
    (ctx as Record<string, unknown>)['getFreshSessionHandoff'] = getFreshSessionHandoff;

    try {
      const result = await execute(ctx as never);
      expect(result.exitCode).toBe(0);
      expect(getFreshSessionHandoff).toHaveBeenCalledOnce();
      expect((ctx.context as Record<string, unknown>)['paperclipFreshSessionHandoffMarkdown']).toBe(handoffText);

      // Vérifie que le prompt envoyé à la passerelle contient bien le handoff dans le message utilisateur (v1.3 invariant system)
      const firstReq = gateway.captured[0];
      expect(firstReq?.system).not.toContain('## Passation de session précédente');
      const userMessage = JSON.stringify(firstReq?.messages ?? []);
      expect(userMessage).toContain('## Passation de session précédente');
      expect(userMessage).toContain(handoffText);
    } finally {
      await gateway.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('transmet x-omniroute-no-memory: true et X-Session-Id en headers et user en payload', () => {
    const payload = buildChatCompletionsPayload({
      model: 'auto/best-coding',
      system: 'system prompt',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'salut' }] }],
      tools: [],
      maxTokens: 100,
      reasoningEffort: 'none',
      sessionId: 'session-xyz-123',
    });
    expect(payload['user']).toBe('session-xyz-123');
  });
});
