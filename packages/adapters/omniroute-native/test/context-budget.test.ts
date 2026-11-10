import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONTEXT_BUDGET_TTL_MS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  clearContextBudgetCache,
  loadContextBudget,
  resolveContextBudget,
} from '../src/shared/context-budget.js';
import { execute } from '../src/server/execute.js';
import { startFakeGateway } from './support/fake-gateway.js';
import { makeTestContext } from './support/test-context.js';

// Valeurs lues sur l'OmniRoute perso le 07/11/2026 (`GET /v1/models/{id}`, ACC-3085).
const CATALOG = {
  'AC-pro-coding': { id: 'AC-pro-coding', owned_by: 'combo', context_length: 872_000, max_input_tokens: 872_000, max_output_tokens: 65_536 },
  'AC-code': { id: 'AC-code', owned_by: 'combo', context_length: 500_000, max_input_tokens: 500_000, max_output_tokens: 65_536 },
  'auto/best-coding': { id: 'auto/best-coding', owned_by: 'combo', context_length: 2_000_000, max_input_tokens: 2_000_000, max_output_tokens: 2_000_000 },
  'AC-free': { id: 'AC-free', owned_by: 'combo', context_length: 256_000, max_input_tokens: 42_000, max_output_tokens: 8_000 },
};
const models = Object.values(CATALOG);

describe('ACC-3085 — resolveContextBudget (fonction pure)', () => {
  it('combo connu : fenêtre du combo, source omniroute', () => {
    expect(resolveContextBudget(models, 'AC-pro-coding', null)).toEqual({
      tokens: 872_000,
      maxOutputTokens: 65_536,
      source: 'omniroute:/v1/models',
      models: [{ id: 'AC-pro-coding', tokens: 872_000, maxOutputTokens: 65_536 }],
    });
  });

  it('modèle et repli connus : le plus petit des deux (Pilote : AC-pro-coding + auto/best-coding)', () => {
    const budget = resolveContextBudget(models, 'AC-pro-coding', 'auto/best-coding');
    expect(budget.tokens).toBe(872_000);
    expect(budget.maxOutputTokens).toBe(65_536);
    expect(budget.source).toBe('omniroute:/v1/models');
    expect(budget.models.map((m) => m.id)).toEqual(['AC-pro-coding', 'auto/best-coding']);
  });

  it('repli plus petit que le modèle : le repli borne le budget', () => {
    const budget = resolveContextBudget(models, 'auto/best-coding', 'AC-code');
    expect(budget.tokens).toBe(500_000);
    expect(budget.maxOutputTokens).toBe(65_536);
    expect(budget.source).toBe('omniroute:/v1/models');
  });

  it('cible inconnue (repli absent du catalogue) : repli prudent 200 000, source défaut', () => {
    const budget = resolveContextBudget(models, 'AC-pro-coding', 'AC-inconnu');
    expect(budget.tokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(200_000);
    expect(budget.source).toBe('défaut');
    expect(budget.models).toEqual([
      { id: 'AC-pro-coding', tokens: 872_000, maxOutputTokens: 65_536 },
      { id: 'AC-inconnu', tokens: null, maxOutputTokens: null },
    ]);
  });

  it('cible connue mais plus petite que le repli prudent : la valeur mesurée reste la borne', () => {
    const budget = resolveContextBudget(models, 'AC-free', 'AC-inconnu');
    expect(budget.tokens).toBe(42_000);
    expect(budget.source).toBe('défaut');
  });

  it('modèle sans fenêtre exploitable (0, négatif, texte) : traité comme inconnu', () => {
    const odd = [{ id: 'm1', context_length: 0 }, { id: 'm2', context_length: -5 }, { id: 'm3', context_length: '872000' }];
    for (const id of ['m1', 'm2', 'm3']) {
      expect(resolveContextBudget(odd, id, null)).toMatchObject({ tokens: 200_000, source: 'défaut' });
    }
  });

  it('OmniRoute KO (aucun catalogue) : repli 200 000, source défaut', () => {
    expect(resolveContextBudget(null, 'AC-pro-coding', 'auto/best-coding')).toMatchObject({
      tokens: 200_000,
      maxOutputTokens: null,
      source: 'défaut',
    });
  });

  it('max_input_tokens plus petit que context_length : l’entrée admise borne le budget', () => {
    expect(resolveContextBudget(models, 'AC-free', null)).toMatchObject({ tokens: 42_000, maxOutputTokens: 8_000 });
  });

  it('advertisedContextLength est lu quand context_length manque', () => {
    expect(resolveContextBudget([{ id: 'c', advertisedContextLength: 300_000 }], 'c', null))
      .toMatchObject({ tokens: 300_000, source: 'omniroute:/v1/models' });
  });

  it('repli identique au modèle : compté une seule fois', () => {
    expect(resolveContextBudget(models, 'AC-code', 'AC-code').models).toHaveLength(1);
  });
});

describe('ACC-3085 — loadContextBudget (lecture OmniRoute, cache 10 min)', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const catalogFetch = () => vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const id = decodeURIComponent(String(url).split('/v1/models/')[1] ?? '');
    const entry = (CATALOG as Record<string, unknown>)[id];
    return entry ? json(entry) : json({ error: { message: 'not found' } }, 404);
  });

  beforeEach(() => clearContextBudgetCache());
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); clearContextBudgetCache(); });

  it('lit /v1/models/{id} du modèle et du repli avec la clé, l’UA sdk-cli, puis met en cache', async () => {
    const fetchMock = catalogFetch();
    vi.stubGlobal('fetch', fetchMock);
    const budget = await loadContextBudget({ baseUrl: 'http://gw.test/', apiKey: 'sk-test', model: 'AC-pro-coding', fallbackModel: 'auto/best-coding' });
    expect(budget).toMatchObject({ tokens: 872_000, source: 'omniroute:/v1/models' });
    const urls = fetchMock.mock.calls.map((c) => String(c[0])).sort();
    expect(urls).toEqual(['http://gw.test/v1/models/AC-pro-coding', 'http://gw.test/v1/models/auto%2Fbest-coding']);
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test');
    expect(headers['User-Agent']).toContain('sdk-cli');

    await loadContextBudget({ baseUrl: 'http://gw.test', apiKey: 'sk-test', model: 'AC-pro-coding', fallbackModel: 'auto/best-coding' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('relit OmniRoute après 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchMock = catalogFetch();
    vi.stubGlobal('fetch', fetchMock);
    const args = { baseUrl: 'http://gw.test', apiKey: 'sk-test', model: 'AC-code', fallbackModel: null };
    await loadContextBudget(args);
    vi.setSystemTime(Date.now() + CONTEXT_BUDGET_TTL_MS - 1);
    await loadContextBudget(args);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2);
    await loadContextBudget(args);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('le cache est propre à la passerelle et à la clé', async () => {
    const fetchMock = catalogFetch();
    vi.stubGlobal('fetch', fetchMock);
    await loadContextBudget({ baseUrl: 'http://gw.test', apiKey: 'key-a', model: 'AC-code', fallbackModel: null });
    await loadContextBudget({ baseUrl: 'http://gw.test', apiKey: 'key-b', model: 'AC-code', fallbackModel: null });
    await loadContextBudget({ baseUrl: 'http://other.test', apiKey: 'key-a', model: 'AC-code', fallbackModel: null });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('OmniRoute injoignable : 200 000 source défaut, sans mise en cache de l’échec', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed'); });
    vi.stubGlobal('fetch', fetchMock);
    const args = { baseUrl: 'http://gw.test', apiKey: 'sk-test', model: 'AC-pro-coding', fallbackModel: 'auto/best-coding' };
    expect(await loadContextBudget(args)).toMatchObject({ tokens: 200_000, source: 'défaut', maxOutputTokens: null });
    await loadContextBudget(args);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('repli introuvable (404) : budget prudent', async () => {
    vi.stubGlobal('fetch', catalogFetch());
    expect(await loadContextBudget({ baseUrl: 'http://gw.test', apiKey: 'sk-test', model: 'AC-pro-coding', fallbackModel: 'AC-disparu' }))
      .toMatchObject({ tokens: 200_000, source: 'défaut' });
  });
});

describe('ACC-3085 — execute() expose la fenêtre détectée', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'omni-ctx-budget-')); clearContextBudgetCache(); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); clearContextBudgetCache(); });

  it('resultJson.contextWindow, ligne de journal et maxTokens borné par max_output_tokens', async () => {
    const gateway = await startFakeGateway({
      modelCatalog: {
        'AC-free': CATALOG['AC-free'],
        'auto/best-coding': CATALOG['auto/best-coding'],
      },
    });
    const logs: string[] = [];
    const { ctx } = makeTestContext({
      config: { baseUrl: gateway.baseUrl, model: 'AC-free', fallbackModel: 'auto/best-coding', maxTokens: 16_384 },
      context: { paperclipWorkspace: { cwd } },
      logs,
    });
    try {
      const result = await execute(ctx as never);
      expect(result.resultJson?.['contextWindow']).toMatchObject({
        tokens: 42_000,
        maxOutputTokens: 8_000,
        source: 'omniroute:/v1/models',
      });
      expect(gateway.captured[0]?.maxTokens).toBe(8_000);
      const out = logs.join('');
      expect(out).toContain('fenêtre de contexte 42000 tokens');
      expect(out).toContain('omniroute:/v1/models');
      expect(out).not.toContain('sk-test');
    } finally { await gateway.close(); }
  });

  it('passerelle sans fenêtre connue : repli 200 000 visible, maxTokens inchangé', async () => {
    const gateway = await startFakeGateway();
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl, maxTokens: 16_384 }, context: { paperclipWorkspace: { cwd } } });
    try {
      const result = await execute(ctx as never);
      expect(result.resultJson?.['contextWindow']).toMatchObject({ tokens: 200_000, source: 'défaut', maxOutputTokens: null });
      expect(gateway.captured[0]?.maxTokens).toBe(16_384);
    } finally { await gateway.close(); }
  });

  it('maxContextChars posé en config : seuils de la config, source config', async () => {
    const gateway = await startFakeGateway({ modelCatalog: { 'auto/best-coding': CATALOG['auto/best-coding'] } });
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl, maxContextChars: 150_000 }, context: { paperclipWorkspace: { cwd } } });
    try {
      const result = await execute(ctx as never);
      expect(result.resultJson?.['contextWindow']).toMatchObject({
        tokens: 2_000_000,
        source: 'config',
        historyBudgetChars: 150_000,
        intraRunBudgetChars: 150_000,
      });
    } finally { await gateway.close(); }
  });
});
