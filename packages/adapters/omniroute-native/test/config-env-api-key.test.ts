import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../src/shared/config.js';
import { execute } from '../src/server/execute.js';
import { testEnvironment } from '../src/server/test.js';
import { startFakeGateway } from './support/fake-gateway.js';
import { makeTestContext } from './support/test-context.js';

/**
 * Régression du canari ACC-3037 (06/11/2026) : Paperclip résout le
 * `secret_ref` de l'agent dans `config.env.ANTHROPIC_API_KEY`, pas dans
 * l'environnement du serveur. Le conteneur `paperclip-ac` ne porte
 * volontairement aucune clé : l'adaptateur répondait `missing_api_key` au
 * test d'environnement et `omniroute_auth_rejected` à l'exécution, alors que
 * la clé de l'agent était bien là.
 */
const AGENT_KEY = 'cle-agent-resolue-depuis-secret-ref';

beforeEach(() => {
  vi.stubEnv('OMNIROUTE_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('OMNIROUTE_BASE_URL', '');
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveConfig — clé et passerelle de l agent dans config.env', () => {
  it('prend ANTHROPIC_API_KEY de config.env quand le serveur n a aucune clé', () => {
    const cfg = resolveConfig({ env: { ANTHROPIC_API_KEY: AGENT_KEY } });

    expect(cfg.apiKey).toBe(AGENT_KEY);
    expect(cfg.apiKeySource).toBe('env(agent):ANTHROPIC_API_KEY');
  });

  it('préfère OMNIROUTE_API_KEY à ANTHROPIC_API_KEY dans config.env', () => {
    const cfg = resolveConfig({
      env: { ANTHROPIC_API_KEY: 'cle-secondaire', OMNIROUTE_API_KEY: AGENT_KEY },
    });

    expect(cfg.apiKey).toBe(AGENT_KEY);
    expect(cfg.apiKeySource).toBe('env(agent):OMNIROUTE_API_KEY');
  });

  it('lit une liaison plain résolue ({ type: plain, value })', () => {
    const cfg = resolveConfig({ env: { ANTHROPIC_API_KEY: { type: 'plain', value: AGENT_KEY } } });

    expect(cfg.apiKey).toBe(AGENT_KEY);
    expect(cfg.apiKeySource).toBe('env(agent):ANTHROPIC_API_KEY');
  });

  it('n utilise jamais une référence de secret non résolue', () => {
    const cfg = resolveConfig({
      env: { ANTHROPIC_API_KEY: { type: 'secret_ref', secretId: '00000000-0000-0000-0000-000000000000' } },
    });

    expect(cfg.apiKey).toBeNull();
    expect(cfg.apiKeySource).toBe('none');
  });

  it('config.apiKey reste prioritaire sur config.env', () => {
    const cfg = resolveConfig({ apiKey: 'cle-config', env: { ANTHROPIC_API_KEY: AGENT_KEY } });

    expect(cfg.apiKey).toBe('cle-config');
    expect(cfg.apiKeySource).toBe('config');
  });

  it('config.env passe avant l environnement du serveur', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'cle-du-serveur');
    const cfg = resolveConfig({ env: { ANTHROPIC_API_KEY: AGENT_KEY } });

    expect(cfg.apiKey).toBe(AGENT_KEY);
    expect(cfg.apiKeySource).toBe('env(agent):ANTHROPIC_API_KEY');
  });

  it('écarte une clé masquée dans config.env et retombe sur le serveur', () => {
    vi.stubEnv('OMNIROUTE_API_KEY', 'cle-du-serveur');
    const cfg = resolveConfig({ env: { ANTHROPIC_API_KEY: '***REDACTED***' } });

    expect(cfg.apiKey).toBe('cle-du-serveur');
    expect(cfg.apiKeySource).toBe('env:OMNIROUTE_API_KEY');
  });

  it('reste sans clé quand config.env n a qu un masque et le serveur rien', () => {
    const cfg = resolveConfig({ env: { ANTHROPIC_API_KEY: '***REDACTED***' } });

    expect(cfg.apiKey).toBeNull();
    expect(cfg.apiKeySource).toBe('none');
  });

  it('prend la passerelle de config.env quand baseUrl est absent', () => {
    expect(resolveConfig({ env: { ANTHROPIC_BASE_URL: 'http://agent-gw:20128/' } }).baseUrl).toBe(
      'http://agent-gw:20128',
    );
    expect(
      resolveConfig({
        env: { ANTHROPIC_BASE_URL: 'http://anthropic-gw:1', OMNIROUTE_BASE_URL: 'http://omni-gw:2' },
      }).baseUrl,
    ).toBe('http://omni-gw:2');
  });

  it('baseUrl explicite reste prioritaire sur config.env', () => {
    const cfg = resolveConfig({
      baseUrl: 'http://explicite:20128',
      env: { ANTHROPIC_BASE_URL: 'http://agent-gw:20128' },
    });

    expect(cfg.baseUrl).toBe('http://explicite:20128');
  });
});

describe('testEnvironment — clé seulement dans config.env', () => {
  it('ne signale plus missing_api_key et joint la passerelle avec la clé de l agent', async () => {
    const gateway = await startFakeGateway();
    try {
      const result = await testEnvironment({
        companyId: 'company-1',
        adapterType: 'omniroute_native',
        config: { baseUrl: gateway.baseUrl, env: { ANTHROPIC_API_KEY: AGENT_KEY } },
      } as never);

      const codes = result.checks.map((check) => check.code);
      expect(codes).not.toContain('missing_api_key');
      const apiKeyCheck = result.checks.find((check) => check.code === 'api_key');
      expect(apiKeyCheck?.detail).toBe('Source : env(agent):ANTHROPIC_API_KEY');
      expect(JSON.stringify(result)).not.toContain(AGENT_KEY);
      expect(result.status).not.toBe('fail');
    } finally {
      await gateway.close();
    }
  });

  it('signale missing_api_key quand il n y a de clé nulle part', async () => {
    const result = await testEnvironment({
      companyId: 'company-1',
      adapterType: 'omniroute_native',
      config: { baseUrl: 'http://fake.invalid', env: {} },
    } as never);

    expect(result.status).toBe('fail');
    expect(result.checks.map((check) => check.code)).toContain('missing_api_key');
  });
});

describe('execute — clé seulement dans config.env', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'omniroute-config-env-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('envoie la clé de config.env en Bearer et réussit le run', async () => {
    const gateway = await startFakeGateway();
    const logs: string[] = [];
    try {
      const { ctx } = makeTestContext({
        config: { apiKey: undefined, baseUrl: gateway.baseUrl, env: { ANTHROPIC_API_KEY: AGENT_KEY } },
        context: { paperclipWorkspace: { cwd: root } },
        logs,
      });

      const result = await execute(ctx as never);

      expect(result.errorCode ?? null).toBeNull();
      expect(result.exitCode).toBe(0);
      expect(gateway.captured.length).toBeGreaterThan(0);
      expect(gateway.captured[0]?.authorization).toBe(`Bearer ${AGENT_KEY}`);
      expect(logs.join('')).toContain('clé env(agent):ANTHROPIC_API_KEY');
      expect(logs.join('')).not.toContain(AGENT_KEY);
    } finally {
      await gateway.close();
    }
  });

  it('échoue en omniroute_auth_rejected sans appeler la passerelle quand il n y a aucune clé', async () => {
    const gateway = await startFakeGateway();
    try {
      const { ctx } = makeTestContext({
        config: { apiKey: undefined, baseUrl: gateway.baseUrl, env: {} },
        context: { paperclipWorkspace: { cwd: root } },
      });

      const result = await execute(ctx as never);

      expect(result.errorCode).toBe('omniroute_auth_rejected');
      expect(gateway.captured).toHaveLength(0);
    } finally {
      await gateway.close();
    }
  });
});
