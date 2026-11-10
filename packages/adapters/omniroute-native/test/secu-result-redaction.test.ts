/**
 * Lot sécu — rotation de clé passerelle et masquage des sorties structurées
 * (laboratoire du 06/11/2026, carte t_e8b687c2).
 *
 * Constat reproduit : la clé de la passerelle, connue du masqueur, était
 * masquée dans le transcript et le fichier de session mais recopiée telle
 * quelle dans `resultJson.finalResponse.text` et `resultJson.summary` quand
 * le modèle la renvoyait dans sa réponse finale.
 *
 * Le test exerce le vrai `execute` contre une passerelle loopback SSE qui
 * accepte une seule clé à la fois et renvoie volontairement la clé reçue :
 * A acceptée → A révoquée (401 borné, checkpoint intact) → B acceptée sur la
 * même session, restaurée dans un autre home. Aucune clé (synthétique,
 * aléatoire, en mémoire) ne doit apparaître dans les journaux, le fichier de
 * session, les reçus d'usage ni les résultats.
 *
 * Les valeurs des clés ne sont jamais écrites dans un message d'assertion :
 * on ne compare que des booléens et des chemins de champs.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { execute } from '../src/server/execute.js';

const MARKER = 'ROTATION_HISTORY_SENTINEL';

interface RotationGateway {
  server: Server;
  baseUrl: string;
  /** Clé acceptée en ce moment (révocation = changement de valeur). */
  accept(key: string): void;
  requests: Array<{ phase: number; method: string; authorized: boolean; status: number }>;
  bodies: Array<{ phase: number; raw: string }>;
  phase: number;
  close(): Promise<void>;
}

/**
 * Passerelle loopback : `Authorization: Bearer <clé acceptée>` sinon 401.
 * Premier POST d'un run → appel d'outil `list_dir` (point de contrôle et
 * reçu d'usage intermédiaire) ; POST suivant → texte final qui réémet la clé.
 */
async function startRotationGateway(): Promise<RotationGateway> {
  let accepted = '';
  const state: RotationGateway = {
    server: null as unknown as Server,
    baseUrl: '',
    accept: (key) => { accepted = key; },
    requests: [],
    bodies: [],
    phase: 1,
    close: async () => {},
  };
  const server = createServer((req, res) => {
    const authorized = accepted.length > 0 && req.headers.authorization === `Bearer ${accepted}`;
    state.requests.push({ phase: state.phase, method: req.method ?? '', authorized, status: authorized ? 200 : 401 });
    if (!authorized) {
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture credential revoked', type: 'authentication_error' } }));
      return;
    }
    if (req.method === 'GET') {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fixture/no-model', context_length: 32768 }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      state.bodies.push({ phase: state.phase, raw });
      const body = JSON.parse(raw) as { messages?: Array<{ role: string }> };
      const hasToolResult = (body.messages ?? []).some((m) => m.role === 'tool');
      const usage = { prompt_tokens: 11, completion_tokens: 5 };
      const chunk = hasToolResult
        // Écho volontaire de la clé reçue : sonde du vrai masqueur d'execute.
        ? { model: 'fixture/no-model', choices: [{ delta: { content: `${MARKER} phase=${state.phase} credential=${accepted}` }, finish_reason: 'stop' }], usage }
        : { model: 'fixture/no-model', choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${state.phase}`, function: { name: 'list_dir', arguments: '{"path":"."}' } }] }, finish_reason: 'tool_calls' }], usage };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.server = server;
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  return state;
}

/** Chemins des chaînes qui contiennent l'une des clés (jamais les valeurs). */
function leakPaths(value: unknown, secrets: string[], at: string, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (secrets.some((s) => value.includes(s))) out.push(at);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => leakPaths(item, secrets, `${at}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) leakPaths(entry, secrets, `${at}.${key}`, out);
  }
  return out;
}

let gateway: RotationGateway | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await gateway?.close();
  gateway = null;
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

describe('secu — rotation de clé passerelle et sorties structurées', () => {
  it('A acceptée → A révoquée 401 borné → B acceptée : aucune clé dans résultats, journaux, session ni usage', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'secu-rotation-'));
    dirs.push(root);
    const home1 = path.join(root, 'home-1');
    const home3 = path.join(root, 'home-restored');
    const workspace = path.join(root, 'workspace');
    await Promise.all([home1, home3, workspace].map((p) => fs.mkdir(p, { recursive: true })));

    const keyA = randomBytes(32).toString('hex');
    const keyB = randomBytes(32).toString('hex');
    const secrets = [keyA, keyB];
    gateway = await startRotationGateway();
    const gw = gateway;
    gw.accept(keyA);

    const logs: string[] = [];
    const usage: unknown[] = [];
    const makeCtx = (key: string, home: string, params: Record<string, unknown> | null = null) => ({
      runId: `rotation-${gw.phase}`,
      agent: { id: 'agent-rotation', companyId: 'company-1', name: 'Rotation', adapterType: 'omniroute_native', adapterConfig: {} },
      config: { apiKey: key, baseUrl: gw.baseUrl, model: 'fixture/no-model', timeoutSec: 20, maxTurns: 4, maxEscalations: 0 },
      runtime: { sessionId: null, sessionParams: params, sessionDisplayId: null, taskKey: null },
      context: { taskId: 'task-rotation', paperclipWorkspace: { cwd: workspace, agentHome: home } },
      signal: AbortSignal.timeout(15_000),
      onUsage: async (receipt: unknown) => { usage.push(receipt); },
      onLog: async (_stream: string, text: string) => { logs.push(text); },
      onMeta: async () => {},
      onCancellationReady: async () => {},
      onProviderStopped: async () => {},
      onDispatch: () => {},
    });

    // Run 1 : clé A acceptée, réponse finale qui réémet A.
    const first = await execute(makeCtx(keyA, home1) as never);
    expect(first.exitCode).toBe(0);
    const params = first.sessionParams as Record<string, unknown>;
    const sessionId = String(params['sessionId']);
    const sessionFile = path.join(home1, '.omniroute-sessions', `${sessionId}.json`);
    const saved = await fs.readFile(sessionFile, 'utf8');
    expect(saved.includes(MARKER)).toBe(true);

    // Run 2 : A révoquée côté passerelle (seule B acceptée) ; config encore sur A.
    gw.phase = 2;
    gw.accept(keyB);
    const started = performance.now();
    const failed = await execute(makeCtx(keyA, home1, params) as never);
    const elapsedMs = performance.now() - started;
    const chat2 = gw.requests.filter((r) => r.phase === 2 && r.method === 'POST');
    expect(failed.exitCode).toBe(1);
    expect(failed.errorCode).toBe('omniroute_auth_rejected');
    expect(chat2.map((r) => r.status)).toEqual([401]);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(await fs.readFile(sessionFile, 'utf8')).toBe(saved);
    expect(failed.sessionParams).toEqual(params);
    expect(failed.clearSession).not.toBe(true);

    // Run 3 : clé B sur la même session, restaurée dans un home neuf.
    gw.phase = 3;
    const restoredDir = path.join(home3, '.omniroute-sessions');
    await fs.mkdir(restoredDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(restoredDir, `${sessionId}.json`), saved, { mode: 0o600 });
    const third = await execute(makeCtx(keyB, home3, params) as never);
    expect(third.exitCode).toBe(0);
    expect((third.sessionParams as Record<string, unknown>)['sessionId']).toBe(sessionId);
    expect((third.resultJson ?? {})['resumedSession']).toBe(true);
    expect(gw.bodies.some((b) => b.phase === 3 && b.raw.includes(MARKER))).toBe(true);
    const restored = await fs.readFile(path.join(restoredDir, `${sessionId}.json`), 'utf8');

    // Invariant de confidentialité : chemins vides, jamais de valeur affichée.
    expect(usage.length).toBeGreaterThan(0);
    expect(leakPaths({ saved, restored }, secrets, 'checkpoint')).toEqual([]);
    expect(leakPaths(logs, secrets, 'logs')).toEqual([]);
    expect(leakPaths(usage, secrets, 'usage')).toEqual([]);
    expect(leakPaths({ run1: first, run2: failed, run3: third }, secrets, 'result')).toEqual([]);

    // La réponse finale reste publiée, masquée (booléens : aucun texte affiché).
    for (const run of [first, third]) {
      const json = (run.resultJson ?? {}) as Record<string, unknown>;
      const final = json['finalResponse'] as Record<string, unknown> | undefined;
      const text = String(final?.['text'] ?? '');
      const summary = String(json['summary'] ?? '');
      expect(final?.['disposition']).toBe('final');
      expect(text.includes(MARKER) && text.includes('[REDACTED]')).toBe(true);
      expect(summary === text).toBe(true);
    }
  }, 45_000);
});
