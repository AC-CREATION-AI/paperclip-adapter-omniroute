/**
 * Lot 2 — vérité du résultat et robustesse de la boucle (carte t_e02303e7).
 *
 * Démonstrateurs repris de l'audit lecture seule du 30/10 (A4–A9, A11) :
 * chacun échouait sur main ce0a67c.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAgentLoop, type AgentLoopOptions } from '../src/server/agent-loop.js';
import { buildWorkspaceTools } from '../src/server/tools.js';
import { loadSessionMessages, sessionFilePath, trimSessionMessages } from '../src/server/session.js';
import { OmniRouteClient, type WireMessage } from '../src/shared/client.js';
import { wireMessagesToOpenAi } from '../src/shared/chat-completions.js';
import { execute } from '../src/server/execute.js';
import { makeTestContext } from './support/test-context.js';

let outer: string;
let root: string;
beforeEach(async () => {
  outer = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-lot2-'));
  root = path.join(outer, 'workspace');
  await fs.mkdir(root);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(outer, { recursive: true, force: true });
});

const tool = (name: string) => buildWorkspaceTools(root, undefined).find((t) => t.spec.name === name)!;
function streamResponse(chunks: unknown[], done = true): Response {
  return new Response(
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function modelResult(content: unknown[], stopReason = 'tool_calls') {
  return {
    content,
    stopReason,
    model: 'fake',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    gatewayHeaders: {},
    costUsd: null,
  };
}
function options(client: unknown, more: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    client: client as never, model: 'fake', system: '', initialUserMessage: 'test',
    tools: [], maxTokens: 100, reasoningEffort: 'none', maxTurns: 8,
    emit: async () => {}, warn: async () => {}, ...more,
  };
}
const noop = { spec: { name: 'noop', description: '', input_schema: { type: 'object', properties: {} } }, run: async () => ({ content: 'ok', isError: false }) };
const params = { model: 'fake', system: '', messages: [], tools: [], maxTokens: 100, reasoningEffort: 'none' as const };
const client = () => new OmniRouteClient({ baseUrl: 'http://fake.invalid', apiKey: 'test-key', requestTimeoutMs: 500 });

describe('A5/A6 — seule une réponse terminale complète est publiée', () => {
  it('A5 tours épuisés : la narration d un tour d outil n est pas une réponse finale', async () => {
    const responses = [
      modelResult([{ type: 'text', text: 'Je vais vérifier.' }, { type: 'tool_use', id: 'a', name: 'noop', input: {} }]),
      modelResult([{ type: 'tool_use', id: 'b', name: 'noop', input: {} }]),
    ];
    const mock = { streamMessage: vi.fn(async () => responses.shift()!) };
    const result = await runAgentLoop(options(mock, { maxTurns: 2, tools: [noop] }));
    expect({ stopReason: result.stopReason, finalText: result.finalText }).toEqual({ stopReason: 'max_turns', finalText: '' });
  });

  it('A6 finish_reason=length persistant : pas de finale, run en échec explicite', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([{ choices: [{ delta: { content: 'Réponse coupée au mil' }, finish_reason: 'length' }] }])));
    const { ctx } = makeTestContext({ config: { baseUrl: 'http://fake.invalid', reasoningEffort: 'none' }, context: { paperclipWorkspace: { cwd: root } } });
    const result = await execute(ctx as never);
    expect({ exitCode: result.exitCode, final: (result.resultJson as any)?.finalResponse?.disposition, code: result.errorCode })
      .toEqual({ exitCode: 1, final: undefined, code: 'omniroute_output_truncated' });
  });

  it('A6b une sortie coupée puis complétée est publiée en entier', async () => {
    const responses = [
      modelResult([{ type: 'text', text: 'Début de la ' }], 'length'),
      modelResult([{ type: 'text', text: 'réponse complète.' }], 'stop'),
    ];
    const mock = { streamMessage: vi.fn(async () => responses.shift()!) };
    const result = await runAgentLoop(options(mock));
    expect({ stop: result.stopReason, text: result.finalText, calls: mock.streamMessage.mock.calls.length })
      .toEqual({ stop: 'stop', text: 'Début de la réponse complète.', calls: 2 });
  });
});

describe('A7 — un flux SSE incomplet est une erreur', () => {
  it('EOF sans finish_reason ni [DONE] : rejet au lieu d un outil partiel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'list_dir', arguments: '{"path":' } }] } }] }], false)));
    await expect(client().streamMessage(params, {})).rejects.toThrow(/incomplet/);
  });
  it('finish_reason présent sans [DONE] : accepté (fournisseurs qui omettent la sentinelle)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }], false)));
    const result = await client().streamMessage(params, {});
    expect(result.stopReason).toBe('stop');
  });
});

describe('A8 — les arguments d outil sont validés avant tout effet', () => {
  it('A8 JSON invalide : l outil n est pas exécuté et le modèle reçoit une erreur', async () => {
    let count = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++count === 1
      ? streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad', function: { name: 'list_dir', arguments: '{oops' } }] }, finish_reason: 'tool_calls' }] }])
      : streamResponse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]))));
    const list = tool('list_dir');
    const run = vi.fn(list.run);
    const result = await runAgentLoop(options(client(), { tools: [{ ...list, run }] }));
    const toolResult = result.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    expect(run).not.toHaveBeenCalled();
    expect(toolResult).toMatchObject({ is_error: true });
  });
  it('A8 champ requis absent : refus avant exécution', async () => {
    const run = vi.fn(async () => ({ content: 'écrit', isError: false }));
    const writer = { spec: { name: 'write_file', description: '', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }, run };
    const responses = [modelResult([{ type: 'tool_use', id: 'w', name: 'write_file', input: { path: 'keep.txt' } }]), modelResult([{ type: 'text', text: 'fin' }], 'stop')];
    const mock = { streamMessage: vi.fn(async () => responses.shift()!) };
    await runAgentLoop(options(mock, { tools: [writer] }));
    expect(run).not.toHaveBeenCalled();
  });
  it('A8b write_file sans content n écrase pas un fichier existant', async () => {
    await fs.writeFile(path.join(root, 'keep.txt'), 'preserve');
    const outcome = await tool('write_file').run({ path: 'keep.txt' });
    expect({ isError: outcome.isError, content: await fs.readFile(path.join(root, 'keep.txt'), 'utf8') })
      .toEqual({ isError: true, content: 'preserve' });
  });
});

describe('A4/A11 — chaque appel d outil garde son résultat', () => {
  it('A4 le rognage de session ne laisse aucun résultat orphelin', () => {
    const messages: WireMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'ancien prompt' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 'read_file', input: { path: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'x'.repeat(25) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ];
    for (const budget of [1, 3, 27, 30, 1000]) {
      const kept = trimSessionMessages(messages, budget);
      const converted = wireMessagesToOpenAi(kept);
      const calls = converted.flatMap((m) => (m.tool_calls as Array<{ id: string }> | undefined) ?? []).map((c) => c.id);
      const orphans = converted.filter((m) => m.role === 'tool' && !calls.includes(m.tool_call_id as string));
      expect({ budget, orphans: orphans.length }).toEqual({ budget, orphans: 0 });
      if (kept.length > 0) expect(kept[0]!.role).toBe('user');
    }
  });
  it('A11 annulation au milieu d un lot : un résultat pour chacun des appels', async () => {
    const controller = new AbortController();
    const mock = { streamMessage: vi.fn(async () => modelResult(['a', 'b', 'c', 'd'].map((id) => ({ type: 'tool_use', id, name: 'noop', input: {} })))) };
    const result = await runAgentLoop(options(mock, {
      signal: controller.signal,
      tools: [{ ...noop, run: async () => { controller.abort(); return { content: 'ok', isError: false }; } }],
    }));
    const ids = result.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => (b.type === 'tool_result' ? b.tool_use_id : ''));
    expect({ ids, stop: result.stopReason }).toEqual({ ids: ['a', 'b', 'c', 'd'], stop: 'cancelled' });
  });
});

describe('A9 — une session corrompue ne fait pas tomber le run', () => {
  it('blocs invalides écartés au chargement', async () => {
    await fs.writeFile(sessionFilePath(outer, 'corrupt'), JSON.stringify({ version: 1, sessionId: 'corrupt', messages: [
      { role: 'assistant', content: [null] },
      { role: 'user', content: [{ type: 'text', text: 'valide' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 1, name: 'x' }] },
    ] }));
    const loaded = await loadSessionMessages(outer, 'corrupt');
    expect(() => trimSessionMessages(loaded)).not.toThrow();
    expect(loaded).toEqual([{ role: 'user', content: [{ type: 'text', text: 'valide' }] }]);
  });
});
