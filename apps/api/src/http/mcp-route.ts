/**
 * The MCP server over HTTP, so a hosted client — Claude on the web, say — can
 * reach the same tools the stdio transport serves.
 *
 * Two things are worth being explicit about.
 *
 * **This route is the internet.** Behind a tunnel it is reachable by anyone who
 * guesses the URL, and the tools behind it move money. So it does not exist
 * unless MCP_HTTP_TOKEN is set, and every request has to carry that token —
 * either as a bearer header or, for clients that cannot set one, as ?key=.
 * The comparison is length-safe so the token cannot be recovered by timing.
 *
 * **A server binds to one transport.** Each initialize gets its own
 * McpServer + StreamableHTTPServerTransport pair, kept in a map by session id
 * and dropped when the session closes. Requests that carry a known session id
 * are routed to their existing transport; anything else without one is refused.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../mcp/build.js';

const transports = new Map<string, StreamableHTTPServerTransport>();

/** Constant-time, and false for a length mismatch rather than throwing. */
function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  const key = (request.query as Record<string, unknown> | undefined)?.key;
  return typeof key === 'string' ? key : null;
}

export async function mcpRoutes(app: FastifyInstance, token: string): Promise<void> {
  app.addHook('onClose', async () => {
    for (const transport of transports.values()) await transport.close();
    transports.clear();
  });

  async function handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const given = presentedToken(request);
    if (given === null || !tokenMatches(given, token)) {
      // 401 with a challenge: the shape a well-behaved MCP client retries against.
      await reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer realm="agent-storefront"')
        .send({ error: 'UNAUTHORISED', reason: 'missing or invalid MCP token' });
      return;
    }

    const sessionId = request.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

    if (existing !== undefined) {
      // Hijack first: from here the transport owns the socket, and Fastify must
      // not also try to send a reply on it.
      reply.hijack();
      await existing.handleRequest(request.raw, reply.raw, request.body);
      return;
    }

    if (sessionId !== undefined || !isInitializeRequest(request.body)) {
      await reply
        .code(400)
        .send({ error: 'NO_SESSION', reason: 'unknown session id, and not an initialize request' });
      return;
    }

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) transports.delete(transport.sessionId);
    };

    await createMcpServer().connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  }

  // POST carries the JSON-RPC. GET opens the SSE stream a session reads
  // notifications from. DELETE ends a session.
  app.post('/mcp', handle);
  app.get('/mcp', handle);
  app.delete('/mcp', handle);
}
