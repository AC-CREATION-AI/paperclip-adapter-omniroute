/**
 * Passerelle factice pour les tests de bout en bout.
 *
 * Le serveur OmniRoute est ici un faux : il enregistre les requêtes et
 * répond en SSE. Cela permet de prouver ce qui se passe **réellement** —
 * les corps envoyés, les outils proposés, le rejeu d'historique — sans
 * dépendre d'un service externe et sans coûter un token.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

/** Ce qu'une requête à la passerelle a contient. */
export interface CapturedRequest {
  /** Prompt système, ou chaîne vide si absent. */
  system: string;
  /** Messages hors message système. */
  messages: Array<{ role: string; content: unknown }>;
  /** Noms des outils proposés. */
  tools: string[];
  /** En-tête `Authorization` reçu (clé de test uniquement). */
  authorization: string;
  /** `max_tokens` demandé. */
  maxTokens?: number;
}

export interface FakeGateway {
  server: Server;
  baseUrl: string;
  /** Requêtes capturées, dans l'ordre. */
  captured: CapturedRequest[];
  close(): Promise<void>;
}

export interface FakeGatewayOptions {
  /**
   * Si fourni, le gateway fait demander cet outil au modèle (une requête
   * supplémentaire est émise pour la réponse de l'outil).
   */
  toolCall?: { name: string; input: unknown };
  /**
   * Coût USD posé dans le chunk d'usage (comme OmniRoute en SSE). `undefined`
   * reproduit une passerelle qui ne donne pas de coût.
   */
  costUsd?: number;
  /** Modèle renvoyé par la passerelle dans les chunks. Défaut 'auto/best-coding'. */
  model?: string;
  /** Compteurs de tokens renvoyés dans le chunk d'usage final. */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** Fiches renvoyées par `GET /v1/models/{id}` (fenêtre de contexte, ACC-3085). */
  modelCatalog?: Record<string, unknown>;
}

/** Démarre une fausse passerelle OmniRoute. */
export async function startFakeGateway(
  options: FakeGatewayOptions = {},
): Promise<FakeGateway> {
  const captured: CapturedRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      const entry = options.modelCatalog?.[decodeURIComponent(req.url.slice('/v1/models/'.length))];
      if (entry) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(entry));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'auto/best-coding' }] }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      let parsed: {
        messages?: Array<{ role: string; content: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
        max_tokens?: number;
      } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = {};
      }
      const system = (parsed.messages ?? []).find((m) => m.role === 'system')?.content;
      captured.push({
        system: typeof system === 'string' ? system : '',
        messages: (parsed.messages ?? []).filter((m) => m.role !== 'system'),
        tools: (parsed.tools ?? []).map((t) => t.function?.name ?? '?'),
        authorization: req.headers.authorization ?? '',
        ...(typeof parsed.max_tokens === 'number' ? { maxTokens: parsed.max_tokens } : {}),
      });

      const modelName = options.model ?? 'auto/best-coding';
      const promptTok = options.usage?.prompt_tokens ?? 90;
      const compTok = options.usage?.completion_tokens ?? 7;
      const chunks: string[] = [];
      if (options.toolCall && captured.length === 1) {
        chunks.push(
          `data: ${JSON.stringify({
            model: modelName,
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      function: {
                        name: options.toolCall.name,
                        arguments: JSON.stringify(options.toolCall.input),
                      },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        chunks.push(
          `data: ${JSON.stringify({
            model: modelName,
            choices: [{ delta: { content: 'termine' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: options.usage?.prompt_tokens ?? 120, completion_tokens: options.usage?.completion_tokens ?? 12, ...costField(options) },
          })}\n\n`,
        );
      } else {
        chunks.push(
          `data: ${JSON.stringify({
            model: modelName,
            choices: [{ delta: { content: 'bonjour' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: promptTok, completion_tokens: compTok, ...costField(options) },
          })}\n\n`,
        );
      }
      chunks.push('data: [DONE]\n\n');

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunks.join(''));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    captured,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function costField(options: FakeGatewayOptions): { cost?: number } {
  return options.costUsd === undefined ? {} : { cost: options.costUsd };
}
