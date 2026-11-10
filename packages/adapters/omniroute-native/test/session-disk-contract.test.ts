import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { execute } from '../src/server/execute.js';
import { loadSessionState, saveSessionMessages, sessionFilePath, SessionWriter } from '../src/server/session.js';
import { purgeSessionDir } from '../src/server/session-store.js';
import type { WireMessage } from '../src/shared/wire.js';
import { makeTestContext } from './support/test-context.js';
import { startScriptedGateway } from './support/secu-gateway.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-disk-contract-'));
  dirs.push(dir);
  return dir;
}
const sentinel: WireMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'ancienne tâche de la source incompatible' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'INCOMPATIBLE_SCHEMA_SENTINEL' }] },
];
const fresh: WireMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'nouveau checkpoint' }] }];
const incompatible = [
  { name: 'future version alone', envelope: { version: 999, sessionId: 'probe' } },
  { name: 'wrong identity alone', envelope: { version: 1, sessionId: 'wrong-id' } },
  { name: 'both defects', envelope: { version: 999, sessionId: 'wrong-id' } },
  { name: 'unversioned is not a historical writer format', envelope: { sessionId: 'probe' } },
  { name: 'string version', envelope: { version: '1', sessionId: 'probe' } },
  { name: 'old version', envelope: { version: 0, sessionId: 'probe' } },
  { name: 'missing identity', envelope: { version: 1 } },
  { name: 'numeric identity', envelope: { version: 1, sessionId: 73 } },
];

describe('disk session envelope contract', () => {
  it.each(incompatible)('rejects $name without replay or checkpoint overwrite', async ({ envelope }) => {
    const dir = await tempDir();
    const file = sessionFilePath(dir, 'probe');
    const raw = JSON.stringify({ ...envelope, messages: sentinel }, null, 2);
    await fs.writeFile(file, raw, { mode: 0o600 });
    expect(await loadSessionState(dir, 'probe')).toEqual({ status: 'corrupt', messages: [] });
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
    expect(await saveSessionMessages(dir, 'probe', fresh)).toBe(false);
    const writer = new SessionWriter({ baseDir: dir, sessionId: 'probe', historyLength: 0 });
    expect(await writer.save(fresh)).toBe(false);
    expect(writer.hasSaved).toBe(false);
    expect(writer.lastError).toMatch(/incompatible/i);
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
    // A failed checkpoint must not mark pending messages as persisted.
    await fs.unlink(file);
    expect(await writer.save(fresh)).toBe(true);
    expect(writer.lastError).toBeNull();
    expect(await loadSessionState(dir, 'probe')).toEqual({ status: 'ok', messages: fresh });
  });

  it.each(incompatible)('purge preserves $name before scrub or retention deletion', async ({ envelope }) => {
    for (const mode of [0o600, 0o644]) {
      const dir = await tempDir();
      const file = sessionFilePath(dir, 'probe');
      const raw = JSON.stringify({ ...envelope, messages: sentinel }, null, 2);
      await fs.writeFile(file, raw);
      await fs.chmod(file, mode);
      const before = await fs.stat(file);
      const old = new Date(0);
      await fs.utimes(file, old, old);
      const hash = (text: string) => createHash('sha256').update(text).digest('hex');
      // Retention first, then migration with a custom scrubber: neither may
      // rewrite/rename/delete an envelope that cannot be resumed.
      for (const options of [{ ttlMs: 1 }, { keep: ['probe'], scrub: () => 'rewritten' }]) {
        await fs.chmod(file, mode);
        const report = await purgeSessionDir(dir, options);
        expect(report.deleted).toBe(0);
        expect(report.scrubbed).toBe(0);
        expect(hash(await fs.readFile(file, 'utf8'))).toBe(hash(raw));
        expect((await fs.stat(file)).ino).toBe(before.ino);
      }
    }
  });

  it('keeps historical version1 files readable without requiring updatedAt', async () => {
    const dir = await tempDir();
    await fs.writeFile(sessionFilePath(dir, 'probe'), JSON.stringify({ version: 1, sessionId: 'probe', messages: sentinel }));
    expect(await loadSessionState(dir, 'probe')).toEqual({ status: 'ok', messages: sentinel });
    expect(await saveSessionMessages(dir, 'probe', fresh)).toBe(true);
    expect(JSON.parse(await fs.readFile(sessionFilePath(dir, 'probe'), 'utf8'))).toMatchObject({ version: 1, sessionId: 'probe', messages: fresh });
  });

  it('compares logical identity exactly, not the sanitized filename', async () => {
    const dir = await tempDir();
    expect(sessionFilePath(dir, 'a/b')).toBe(sessionFilePath(dir, 'a_b'));
    expect(await saveSessionMessages(dir, 'a/b', fresh)).toBe(true);
    expect((await loadSessionState(dir, 'a/b')).status).toBe('ok');
    expect(await loadSessionState(dir, 'a_b')).toEqual({ status: 'corrupt', messages: [] });
    const file = sessionFilePath(dir, 'a/b');
    const raw = await fs.readFile(file, 'utf8');
    await fs.chmod(file, 0o644);
    expect((await purgeSessionDir(dir, { keep: ['a_b'], scrub: () => 'rewritten' })).scrubbed).toBe(0);
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
    expect(await saveSessionMessages(dir, 'a_b', sentinel)).toBe(false);
    expect((await loadSessionState(dir, 'a/b')).messages).toEqual(fresh);
  });

  it('still salvages valid blocks from partially malformed version1 messages', async () => {
    const dir = await tempDir();
    await fs.writeFile(sessionFilePath(dir, 'probe'), JSON.stringify({ version: 1, sessionId: 'probe', messages: [
      null, { role: 'system', content: [{ type: 'text', text: 'discard' }] },
      { role: 'assistant', content: [null, { type: 'text', text: 'keep' }, { type: 'unknown' }] },
      { role: 'user', content: [null] },
    ] }));
    expect(await loadSessionState(dir, 'probe')).toEqual({ status: 'ok', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'keep' }] }] });
  });

  it('still handles missing files and malformed JSON without throwing', async () => {
    const dir = await tempDir();
    expect(await loadSessionState(dir, 'probe')).toEqual({ status: 'missing', messages: [] });
    expect(await saveSessionMessages(dir, 'probe', fresh)).toBe(true);
    for (const raw of ['{', 'null', '[]', JSON.stringify({ version: 1, sessionId: 'probe', messages: null })]) {
      await fs.writeFile(sessionFilePath(dir, 'probe'), raw);
      expect(await loadSessionState(dir, 'probe')).toEqual({ status: 'corrupt', messages: [] });
    }
  });

  it.each([0o600, 0o644])('real execute warns, never sends incompatible history, and preserves source bytes from mode %s', async (mode) => {
    const home = await tempDir();
    const dir = path.join(home, '.omniroute-sessions');
    await fs.mkdir(dir);
    const file = sessionFilePath(dir, 'probe');
    const raw = JSON.stringify({ version: 999, sessionId: 'wrong-id', messages: sentinel }, null, 2);
    await fs.writeFile(file, raw, { mode });
    await fs.chmod(file, mode);
    const before = await fs.stat(file);
    const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
    const beforeSha = sha256(await fs.readFile(file, 'utf8'));
    const gateway = await startScriptedGateway(() => ({ text: 'réponse neuve' }));
    const logs: string[] = [];
    try {
      const { ctx } = makeTestContext({
        logs, config: { baseUrl: gateway.baseUrl },
        context: { paperclipWorkspace: { cwd: home, agentHome: home } },
        runtime: { sessionId: null, sessionParams: { sessionId: 'probe', omnirouteNativeSession: true }, sessionDisplayId: 'probe', taskKey: null },
      });
      const result = await execute(ctx as never);
      expect(result.exitCode).toBe(0);
      expect(gateway.requests.length).toBeGreaterThan(0);
      expect(gateway.requests.map((r) => r.raw).join('')).not.toContain('INCOMPATIBLE_SCHEMA_SENTINEL');
      expect(logs.join('')).toMatch(/probe illisible/);
      expect(logs.join('')).toMatch(/incompatible/i);
      expect((result.resultJson as Record<string, unknown>)['resumedSession']).toBe(false);
      const afterRaw = await fs.readFile(file, 'utf8');
      const after = await fs.stat(file);
      expect(sha256(afterRaw)).toBe(beforeSha);
      expect(afterRaw).toBe(raw);
      expect(after.ino).toBe(before.ino);
      expect(after.mode & 0o777).toBe(0o600);
    } finally {
      await gateway.close();
    }
  });
});
