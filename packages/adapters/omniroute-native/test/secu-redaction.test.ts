/**
 * Lot sécurité — masquage des secrets (ACC-2300, partie adaptateur).
 *
 * Constat mesuré en production : un jeton de run (JWT) en clair dans un
 * fichier de session `0644`, recopié depuis la sortie d'un `env` lancé par
 * l'agent. Toute sortie d'outil doit être masquée AVANT d'entrer dans
 * l'historique (et donc avant le modèle, le transcript et le disque), et le
 * fichier de session est masqué une seconde fois à l'écriture.
 *
 * Toutes les valeurs ci-dessous sont fictives et assemblées à l'exécution.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { execute } from '../src/server/execute.js';
import { makeTestContext } from './support/test-context.js';
import { fakeJwt, startScriptedGateway, type ScriptedGateway } from './support/secu-gateway.js';

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/;
const PG_PASSWORD = ['mot', 'de', 'passe', 'fictif', '42'].join('');
const PG_URL = `postgres://paperclip:${PG_PASSWORD}@postgres-paperclip:5432/paperclip`;
const SK_KEY = ['sk', 'fictive0123456789abcdefghijKLMN'].join('-');
const API_KEY_FICTIVE = ['valeur', 'fictive', '123456'].join('-');
const PCP_KEY = `pcp_${'ab12'.repeat(12)}`;

async function loadRedactor() {
  return import('../src/server/secrets-redact.js');
}

describe('secu — masquage des motifs de secrets', () => {
  it('masque un JWT, une URL postgres avec mot de passe et des clés connues', async () => {
    const { redactSecrets } = await loadRedactor();
    const jwt = fakeJwt('a');
    const text = [
      `PAPERCLIP_RUNTIME_TOOLS_TOKEN=${jwt}`,
      `DATABASE_URL=${PG_URL}`,
      `psql ${PG_URL} -c 'select 1'`,
      `OPENAI_API_KEY=${SK_KEY}`,
      `clé paperclip ${PCP_KEY}`,
      `Authorization: Bearer ${'Z'.repeat(40)}`,
      `{"apiKey":"${API_KEY_FICTIVE}","model":"auto"}`,
      'password: hunter2-fictif-999',
    ].join('\n');
    const out = redactSecrets(text);
    expect(out).not.toMatch(JWT_RE);
    expect(out).not.toContain(PG_PASSWORD);
    expect(out).not.toContain(SK_KEY);
    expect(out).not.toContain(PCP_KEY);
    expect(out).not.toContain('Z'.repeat(40));
    expect(out).not.toContain(API_KEY_FICTIVE);
    expect(out).not.toContain('hunter2-fictif-999');
    expect(out).toContain('[REDACTED]');
    // Le contexte utile reste lisible : nom de variable, hôte, utilisateur.
    expect(out).toContain('PAPERCLIP_RUNTIME_TOOLS_TOKEN=[REDACTED]');
    expect(out).toContain('DATABASE_URL=[REDACTED]');
    expect(out).toContain('postgres://paperclip:[REDACTED]@postgres-paperclip:5432/paperclip');
    expect(out).toContain('"model":"auto"');
  });

  it('masque une clé privée PEM et une valeur connue quelle que soit sa forme', async () => {
    const { redactSecrets } = await loadRedactor();
    const pem = [['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAfictif', '-----END PRIVATE KEY-----'].join('\n');
    const known = 'valeur-connue-fictive-77';
    const out = redactSecrets(`début\n${pem}\nla valeur ${known} apparaît sans nom`, [known]);
    expect(out).not.toContain('MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAfictif');
    expect(out).not.toContain(known);
    expect(out).toContain('début');
  });

  it('ne masque pas le texte ordinaire', async () => {
    const { redactSecrets } = await loadRedactor();
    const text = [
      'PAPERCLIP_TASK_ID=TASK-2300',
      'PAPERCLIP_API_URL=http://paperclip:3100',
      'GIT_AUTHOR_NAME=paperclip-bot',
      'max_tokens: 4096',
      'https://gitea.example/repo.git',
      'Tests 242 passed',
    ].join('\n');
    expect(redactSecrets(text)).toBe(text);
  });

  it('reconnaît les noms de variables secrètes', async () => {
    const { isSecretEnvKey } = await loadRedactor();
    for (const key of ['PAPERCLIP_API_KEY', 'PAPERCLIP_RUNTIME_TOOLS_TOKEN', 'DATABASE_URL', 'BETTER_AUTH_SECRET', 'ANTHROPIC_API_KEY', 'PGPASSWORD', 'PAPERCLIP_AGENT_PRIVATE_KEY', 'apiKey', 'accessToken']) {
      expect(isSecretEnvKey(key), key).toBe(true);
    }
    for (const key of ['PAPERCLIP_TASK_ID', 'PAPERCLIP_API_URL', 'GIT_AUTHOR_NAME', 'PATH', 'HOME', 'max_tokens', 'PAPERCLIP_RUNTIME_TOOLS_MCP_URL']) {
      expect(isSecretEnvKey(key), key).toBe(false);
    }
  });
});

describe('secu — sortie d’outil masquée avant l’historique et le disque (bout en bout)', () => {
  let gateway: ScriptedGateway | null = null;
  let dir = '';
  afterEach(async () => {
    await gateway?.close();
    gateway = null;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('un `env` de l’agent n’expose ni le jeton de run, ni la base, ni une clé', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secu-redact-'));
    const runToken = fakeJwt('run');
    // Un JWT hors environnement, recomposé par le shell : la commande elle-même
    // ne contient pas le motif, seule la sortie le contient.
    const [p1, p2, p3] = fakeJwt('stray').split('.');
    gateway = await startScriptedGateway((_req, index) =>
      index === 0
        ? { toolCalls: [{ id: 'call_env', name: 'shell', input: { command: `env; printf '%s.%s.%s\\n' ${p1} ${p2} ${p3}; echo 'X_TOKEN="valeur fictive longue"'` } }] }
        : { text: 'fini' },
    );
    const logs: string[] = [];
    const { ctx } = makeTestContext({
      logs,
      config: {
        baseUrl: gateway.baseUrl,
        env: { DATABASE_URL: PG_URL, OPENAI_API_KEY: SK_KEY },
      },
      context: { paperclipWorkspace: { cwd: dir, agentHome: dir } },
    });
    (ctx as Record<string, unknown>)['authToken'] = runToken;

    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(0);
    expect(gateway.requests.length).toBe(2);

    // 1. Ce qui repart vers le modèle (historique du run) est masqué.
    const toolTurn = gateway.requests[1]!.raw;
    expect(toolTurn).toContain('PAPERCLIP_API_KEY=');
    expect(toolTurn).not.toContain(runToken);
    expect(toolTurn).not.toMatch(JWT_RE);
    expect(toolTurn).not.toContain(PG_PASSWORD);
    expect(toolTurn).not.toContain(SK_KEY);

    // 2. Le transcript du run (journal Paperclip) est masqué.
    const transcript = logs.join('');
    expect(transcript).not.toContain(runToken);
    expect(transcript).not.toMatch(JWT_RE);
    expect(transcript).not.toContain(PG_PASSWORD);
    expect(transcript).not.toContain('valeur fictive longue');
    // Chaque ligne de transcript reste un JSON valide après masquage.
    for (const line of transcript.split('\n').filter((l) => l.startsWith('{'))) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // 3. Le fichier de session ne contient aucun motif.
    const sessionId = (result.sessionParams as { sessionId: string }).sessionId;
    const file = path.join(dir, '.omniroute-sessions', `${sessionId}.json`);
    const stored = await fs.readFile(file, 'utf8');
    expect(stored).toContain('[REDACTED]');
    expect(stored).not.toMatch(JWT_RE);
    expect(stored).not.toContain(PG_PASSWORD);
    expect(stored).not.toContain(SK_KEY);
  });

  it('un historique ancien contenant un JWT est masqué au rechargement et à la réécriture', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secu-legacy-'));
    const sessionDir = path.join(dir, '.omniroute-sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    const legacy = fakeJwt('legacy');
    const sessionId = '0636b06a-legacy';
    await fs.writeFile(
      path.join(sessionDir, `${sessionId}.json`),
      JSON.stringify({
        version: 1,
        sessionId,
        updatedAt: new Date().toISOString(),
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'tâche' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'env' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `PAPERCLIP_RUNTIME_TOOLS_TOKEN=${legacy}` }] },
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        ],
      }),
      { mode: 0o644 },
    );
    gateway = await startScriptedGateway(() => ({ text: 'suite' }));
    const { ctx } = makeTestContext({
      config: { baseUrl: gateway.baseUrl },
      context: { paperclipWorkspace: { cwd: dir, agentHome: dir } },
      runtime: { sessionId: null, sessionParams: { sessionId, omnirouteNativeSession: true }, sessionDisplayId: null, taskKey: null },
    });
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(0);
    expect(gateway.requests[0]!.raw).not.toContain(legacy);
    const stored = await fs.readFile(path.join(sessionDir, `${sessionId}.json`), 'utf8');
    expect(stored).not.toContain(legacy);
    expect(stored).not.toMatch(JWT_RE);
    const mode = (await fs.stat(path.join(sessionDir, `${sessionId}.json`))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('masque les jetons serveurs MCP même non JWT dans les logs et sorties d’exécution', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secu-mcp-token-'));
    const customMcpToken = 'custom_opaque_token_xyz_987654321';
    gateway = await startScriptedGateway(() => ({ text: 'ok' }));

    const { ctx } = makeTestContext({
      config: { baseUrl: gateway.baseUrl },
      context: { paperclipWorkspace: { cwd: dir, agentHome: dir } },
    });

    const mcpServers = [
      { name: 'opaque-mcp', url: 'http://127.0.0.1:9999/mcp', token: customMcpToken, connectionId: 'c1' },
    ];
    (ctx as any).runtimeMcp = {
      getServers: () => mcpServers,
    };

    const stdoutLines: string[] = [];
    (ctx as any).onLog = async (stream: string, line: string) => {
      if (stream === 'stdout') stdoutLines.push(line);
    };

    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(0);

    const fullStdout = stdoutLines.join('\n');
    expect(fullStdout).not.toContain(customMcpToken);

    const sessionId = (result.sessionParams as { sessionId: string }).sessionId;
    const file = path.join(dir, '.omniroute-sessions', `${sessionId}.json`);
    const stored = await fs.readFile(file, 'utf8');
    expect(stored).not.toContain(customMcpToken);
  });
});
