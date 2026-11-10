import { describe, expect, it } from 'vitest';

import { runAgentLoop, type AgentLoopOptions } from '../src/server/agent-loop.js';
import type { OmniRouteClient, WireContentBlock } from '../src/shared/client.js';

type Snapshot = Parameters<NonNullable<AgentLoopOptions['onCheckpoint']>>[0];
const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 };
const reply = (content: WireContentBlock[], costUsd: number | null = 0.1) => ({
  content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_calls' : 'stop',
  model: 'served', usage, gatewayHeaders: {}, costUsd,
});
const call = (id: string, name = 'noop', input: Record<string, unknown> = {}) =>
  reply([{ type: 'tool_use', id, name, input }]);
const done = () => reply([{ type: 'text', text: 'fini' }]);

function options(respond: (model: string, n: number) => ReturnType<typeof reply>, more: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  const counts: Record<string, number> = {};
  return {
    client: { streamMessage: async ({ model }: { model: string }) => {
      counts[model] = (counts[model] ?? 0) + 1;
      return respond(model, counts[model]!);
    } } as unknown as OmniRouteClient,
    model: 'AC-task', system: '', initialUserMessage: 'mission',
    tools: [{ spec: { name: 'noop', description: '', input_schema: { type: 'object', properties: {} } }, run: async () => ({ content: 'ok', isError: false }) }],
    maxTokens: 100, reasoningEffort: 'none', maxTurns: 2,
    emit: async () => {}, warn: async () => {}, ...more,
  };
}

describe('checkpoints — usage cumulé du run', () => {
  it('rejoue la sonde PR #20 : l’escalade ne remet pas le reçu per_run à zéro', async () => {
    const snapshots: Snapshot[] = [];
    const result = await runAgentLoop(options((model, n) =>
      model === 'AC-task' || n === 1 ? call(`${model}-${n}`) : done(), {
      escalationModels: ['AC-code'],
      onCheckpoint: async (snapshot) => { snapshots.push(snapshot); },
    }));
    expect(result).toMatchObject({ inputTokens: 50, turns: 5, finalModel: 'AC-code' });
    // La tentative terminée consomme 3 appels (dont la synthèse vaine),
    // puis AC-code a déjà consommé son premier tour d’outil : 30 + 10.
    expect(snapshots.map((s) => s.inputTokens)).toEqual([10, 20, 40]);
    expect(snapshots.at(-1)).toMatchObject({
      turns: 4, outputTokens: 4, cacheReadTokens: 8, cacheWriteTokens: 12, costTurnsMissing: 0,
    });
    expect(snapshots.at(-1)!.costUsd).toBeCloseTo(0.4);
    expect(result.costUsd).toBeCloseTo(0.5);
  });

  it.each([null, 0, 0.2])('inclut les sous-tâches parallèles terminées, sans double compte (coût enfant %s)', async (childCost) => {
    const snapshots: Snapshot[] = [];
    const result = await runAgentLoop(options((model, n) => {
      if (model === 'AC-child') return reply([{ type: 'text', text: 'lu' }], childCost);
      if (n === 1) return reply([
        { type: 'tool_use', id: 's1', name: 'subtask', input: { task: 'lecture A' } },
        { type: 'tool_use', id: 's2', name: 'subtask', input: { task: 'lecture B' } },
      ]);
      return n === 2 ? call('s3', 'subtask', { task: 'lecture C' }) : done();
    }, {
      maxTurns: 3, subtask: { model: 'AC-child', maxTurns: 1, timeoutSec: 10 },
      onCheckpoint: async (snapshot) => { snapshots.push(snapshot); },
    }));
    expect(result.subtasks).toHaveLength(3);
    expect(snapshots.map((s) => s.inputTokens)).toEqual([30, 50]);
    expect(snapshots.at(-1)).toMatchObject({
      turns: 2, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 15,
      costTurnsMissing: childCost === null ? 3 : 0,
    });
    expect(snapshots.at(-1)!.costUsd).toBeCloseTo(0.2 + 3 * (childCost ?? 0));
    expect(result).toMatchObject({ turns: 3, inputTokens: 60, outputTokens: 6, cacheReadTokens: 12, cacheWriteTokens: 18 });
    expect(result.costUsd).toBeCloseTo(0.3 + 3 * (childCost ?? 0));
  });

  it.each([false, true])('cumule deux escalades et leurs sous-tâches (interruption au dernier checkpoint : %s)', async (interrupt) => {
    const snapshots: Snapshot[] = [];
    const controller = new AbortController();
    const result = await runAgentLoop(options((model, n) => {
      if (model === 'AC-child') return done();
      if (model === 'AC-final' && n === 2) return done();
      return call(`${model}-${n}`, 'subtask', { task: 'lecture' });
    }, {
      maxTurns: 1, escalationModels: ['AC-code', 'AC-final'], maxEscalations: 2,
      subtask: { model: 'AC-child', maxTurns: 1, timeoutSec: 10 }, signal: controller.signal,
      onCheckpoint: async (snapshot) => {
        snapshots.push(snapshot);
        if (interrupt && snapshots.length === 3) controller.abort();
      },
    }));
    expect(result.escalations).toHaveLength(2);
    expect(result.subtasks).toHaveLength(3);
    expect(snapshots.map((s) => s.inputTokens)).toEqual([20, 50, 80]);
    expect(snapshots.at(-1)).toMatchObject({
      turns: 5, outputTokens: 8, cacheReadTokens: 16, cacheWriteTokens: 24, costTurnsMissing: 0,
    });
    expect(snapshots.at(-1)!.costUsd).toBeCloseTo(0.8);
    expect(result).toMatchObject({
      inputTokens: interrupt ? 80 : 90, turns: interrupt ? 5 : 6,
      completion: interrupt ? 'cancelled' : 'completed', finalModel: 'AC-final',
    });
    expect(result.costUsd).toBeCloseTo(interrupt ? 0.8 : 0.9);
  });

  it.each([null, 0])('conserve la distinction coût inconnu / zéro sur plusieurs tentatives (%s)', async (cost) => {
    const snapshots: Snapshot[] = [];
    await runAgentLoop(options((model, n) => ({
      ...(model === 'AC-final' && n === 2 ? done() : call(`${model}-${n}`)), costUsd: cost,
    }), {
      maxTurns: 1, escalationModels: ['AC-code', 'AC-final'], maxEscalations: 2,
      onCheckpoint: async (snapshot) => { snapshots.push(snapshot); },
    }));
    expect(snapshots.map((s) => s.inputTokens)).toEqual([10, 30, 50]);
    expect(snapshots.map((s) => s.costUsd)).toEqual([cost, cost, cost]);
    expect(snapshots.map((s) => s.costTurnsMissing)).toEqual(cost === null ? [1, 3, 5] : [0, 0, 0]);
  });

  it('sans escalade ni sous-tâche, garde l’usage local et tolère un rappel en panne', async () => {
    const snapshots: Snapshot[] = [];
    const result = await runAgentLoop(options((_model, n) => n === 1 ? call('a') : done(), {
      onCheckpoint: async (snapshot) => { snapshots.push(snapshot); throw new Error('stockage indisponible'); },
    }));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, turns: 1 });
    expect(result).toMatchObject({ inputTokens: 20, turns: 2, completion: 'completed', finalText: 'fini' });
    expect(result.costUsd).toBeCloseTo(0.2);
  });
});
