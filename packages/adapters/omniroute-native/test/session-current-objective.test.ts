// Real execute/HTTP/SSE paths with fixture model responses; npm helpers, no upstream alias.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPaperclipWorkspaceEnv } from '@paperclipai/adapter-utils/server-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentLoop } from '../src/server/agent-loop.js';
import { execute } from '../src/server/execute.js';
import { saveSessionMessages } from '../src/server/session.js';
import { OmniRouteClient, type WireMessage } from '../src/shared/client.js';
import { startFakeGateway } from './support/fake-gateway.js';
import { startScriptedGateway } from './support/secu-gateway.js';
import { makeTestContext } from './support/test-context.js';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'session-objective-'));
  dirs.push(dir);
  return dir;
}
const text = (value: string): WireMessage => ({ role: 'user', content: [{ type: 'text', text: value }] });
const occurrences = (value: string, needle: string) => value.split(needle).length - 1;
const previous: WireMessage[] = [text('OLD_OBJECTIVE'), { role: 'assistant', content: [{ type: 'text', text: 'done' }] }];
async function resumed(dir: string) {
  await saveSessionMessages(join(dir, '.omniroute-sessions'), 'previous-session', previous);
  return { sessionParams: { sessionId: 'previous-session', omnirouteNativeSession: true } };
}
function assertPairs(messages: WireMessage[]) {
  const blocks = messages.flatMap((message) => message.content);
  const calls = blocks.filter((block) => block.type === 'tool_use').map((block) => block.id).sort();
  const results = blocks.filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id).sort();
  expect(calls).toEqual(['large-result']);
  expect(results).toEqual(calls);
}

describe('current objective and handoff with npm adapter-utils', () => {
  it('fresh brief and loader render the fresh handoff exactly once (positive control)', async () => {
    const dir = await workspace();
    const gateway = await startFakeGateway(); closers.push(gateway.close);
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl }, context: {
      paperclipWorkspace: { cwd: dir }, paperclipTaskMarkdown: '# Current task',
    } });
    ctx.getFreshSessionHandoff = async () => 'FRESH_HANDOFF';
    expect((await execute(ctx as never)).exitCode).toBe(0);
    expect(occurrences(JSON.stringify(gateway.captured[0]!.messages), 'FRESH_HANDOFF')).toBe(1);
  });

  it.each(['null', 'blank', 'throws'])('does not promote stale handoff when loader returns %s', async (mode) => {
    const dir = await workspace();
    const gateway = await startFakeGateway(); closers.push(gateway.close);
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl }, context: {
      paperclipWorkspace: { cwd: dir }, paperclipTaskMarkdown: '# Current task',
      paperclipFreshSessionHandoffMarkdown: 'STALE_HANDOFF',
    } });
    ctx.getFreshSessionHandoff = async () => {
      if (mode === 'throws') throw new Error('optional loader unavailable');
      return mode === 'null' ? null : '   ';
    };
    expect((await execute(ctx as never)).exitCode).toBe(0);
    expect(JSON.stringify(gateway.captured[0]!.messages)).not.toContain('STALE_HANDOFF');
  });

  it('real resume excludes fresh and rotation handoffs without calling the loader', async () => {
    const dir = await workspace();
    const gateway = await startFakeGateway(); closers.push(gateway.close);
    const loader = vi.fn(async () => 'UNEXPECTED_HANDOFF');
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl }, runtime: await resumed(dir), context: {
      paperclipWorkspace: { cwd: dir }, paperclipTaskMarkdown: '# Full current task',
      paperclipTaskMarkdownCompact: '# Current delta',
      paperclipFreshSessionHandoffMarkdown: 'STALE_FRESH', paperclipSessionHandoffMarkdown: 'STALE_ROTATION',
    } });
    ctx.getFreshSessionHandoff = loader;
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({ resumedSession: true });
    expect(loader).not.toHaveBeenCalled();
    const prompt = JSON.stringify(gateway.captured[0]!.messages);
    expect(prompt).toContain('OLD_OBJECTIVE');
    expect(prompt).not.toMatch(/STALE_FRESH|STALE_ROTATION/);
  });

  it('history rejection reloads one fresh handoff and excludes stale fresh context', async () => {
    const dir = await workspace();
    const gateway = await startScriptedGateway((request) => request.raw.includes('OLD_OBJECTIVE')
      ? { status: 400, error: { message: 'maximum context length exceeded', code: 'context_length_exceeded' } }
      : { text: 'fresh success' });
    closers.push(gateway.close);
    const loader = vi.fn(async () => 'RETRY_HANDOFF');
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl }, runtime: await resumed(dir), context: {
      paperclipWorkspace: { cwd: dir }, paperclipTaskMarkdown: '# Current task',
      paperclipFreshSessionHandoffMarkdown: 'STALE_RETRY',
    } });
    ctx.getFreshSessionHandoff = loader;
    expect((await execute(ctx as never)).exitCode).toBe(0);
    expect(gateway.requests).toHaveLength(2);
    expect(loader).toHaveBeenCalledTimes(1);
    const retry = gateway.requests[1]!.raw;
    expect(occurrences(retry, 'RETRY_HANDOFF')).toBe(1);
    expect(retry).not.toContain('STALE_RETRY');
    expect(retry).toContain('Current task');
  });

  it.each([false, true])('loop keeps current objective and tool pairs (over budget: %s)', async (large) => {
    let calls = 0;
    const gateway = await startScriptedGateway(() => ++calls === 1
      ? { toolCalls: [{ id: 'large-result', name: 'read_fixture', input: {} }] }
      : { text: 'scripted final' });
    closers.push(gateway.close);
    const outbound: WireMessage[][] = [];
    const client = new OmniRouteClient({ baseUrl: gateway.baseUrl, apiKey: 'fixture-only', requestTimeoutMs: 5000 });
    const streamMessage = client.streamMessage.bind(client);
    vi.spyOn(client, 'streamMessage').mockImplementation(async (input, ...rest) => {
      outbound.push(structuredClone(input.messages));
      return streamMessage(input, ...rest);
    });
    const result = await runAgentLoop({ client, model: 'auto/best-coding', system: '', history: previous,
      initialUserMessage: 'CURRENT_UNICODE_é_OBJECTIVE', intraRunBudget: 50_000,
      tools: [{ spec: { name: 'read_fixture', description: 'fixture only', input_schema: { type: 'object' } },
        run: async () => ({ content: 'é'.repeat(large ? 60_000 : 10), isError: false }) }],
      maxTokens: 100, maxTurns: 3, reasoningEffort: 'none', emit: async () => {}, warn: async () => {},
    });
    expect(result.completion).toBe('completed');
    expect(outbound).toHaveLength(2);
    const second = JSON.stringify(outbound[1]);
    expect(second).toContain('CURRENT_UNICODE_é_OBJECTIVE');
    assertPairs(outbound[1]!);
    if (large) expect(second.length).toBeGreaterThan(50_000); // existing soft budget
    else expect(second).toContain('OLD_OBJECTIVE'); // no unnecessary pruning
  });

  it('system guidance names AGENT_HOME supplied by the actual npm helper', async () => {
    const dir = await workspace();
    const env: Record<string, string> = {};
    applyPaperclipWorkspaceEnv(env, { agentHome: dir });
    expect(env.AGENT_HOME).toBe(dir);
    expect(env.PAPERCLIP_HOME).toBeUndefined();
    const gateway = await startFakeGateway(); closers.push(gateway.close);
    const { ctx } = makeTestContext({ config: { baseUrl: gateway.baseUrl }, context: { paperclipWorkspace: { cwd: dir, agentHome: dir } } });
    expect((await execute(ctx as never)).exitCode).toBe(0);
    expect(gateway.captured[0]!.system).toContain('`AGENT_HOME`');
    expect(gateway.captured[0]!.system).not.toContain('`PAPERCLIP_HOME`');
  });
});
