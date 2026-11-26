import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AgentSession } from '../agent/agent-session.ts';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import { judgeOriginHost } from '../pairing/origin-host.ts';
import { readBoundedText } from '../pairing/pair-route.ts';
import { createHttpWsServer, type ServerHandle } from '../runtime-server/index.ts';
import { registerOperationMcpTools } from './mcp-server.ts';

const HOST = '127.0.0.1';
const PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

type McpConnection = {
  transport: WebStandardStreamableHTTPServerTransport;
  ready: Promise<void>;
};

type Grant = {
  session: AgentSession;
  bearer: Buffer;
  connection?: McpConnection;
};

export class OperationMcpHttpServer {
  private readonly grants = new Map<string, Grant>();
  private listener?: Promise<ServerHandle>;
  private closed = false;

  async grant(session: AgentSession) {
    if (this.closed) throw new Error('Operations MCP server is closed.');
    const { id } = session.getSessionData();
    if (this.grants.has(id)) throw new Error('Operations MCP grant already exists.');
    const grant = { session, bearer: Buffer.from(randomBytes(32).toString('base64url')) };
    this.grants.set(id, grant);
    try {
      this.listener ??= createHttpWsServer({
        hostname: HOST,
        port: 0,
        idleTimeoutSeconds: 30,
        fetch: (request) => this.handleRequest(request),
      }).catch((error) => {
        this.listener = undefined;
        throw error;
      });
      const listener = await this.listener;
      if (this.grants.get(id) !== grant) throw new Error('Operations MCP grant was revoked.');
      return {
        endpoint: `http://${HOST}:${listener.port}${PATH}`,
        bearer: grant.bearer.toString(),
      };
    } catch (error) {
      if (this.grants.get(id) === grant) await this.revoke(id);
      throw error;
    }
  }

  async revoke(sessionId: string) {
    const grant = this.grants.get(sessionId);
    this.grants.delete(sessionId);
    await grant?.connection?.transport.close();
  }

  async close() {
    this.closed = true;
    const revocations = [...this.grants.keys()].map((id) => this.revoke(id));
    const listener = await this.listener?.catch(() => undefined);
    listener?.stop(true);
    await Promise.all(revocations);
  }

  private authenticate(request: Request) {
    const credential = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
    if (!credential) return undefined;
    const bearer = Buffer.from(credential[1]);
    let matched: Grant | undefined;
    for (const grant of this.grants.values()) {
      if (timingSafeEqual(grant.bearer, bearer)) matched = grant;
    }
    return matched;
  }

  private connect(grant: Grant): McpConnection {
    const server = new McpServer({ name: OPERATIONS_MCP_SERVER_NAME, version: '1' });
    registerOperationMcpTools(
      (name, description, inputSchema, handler) =>
        server.registerTool(name, { description, inputSchema }, handler),
      ...grant.session.getOperationMcpRegistration()
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      keepAliveMs: 0,
    });
    return { transport, ready: server.connect(transport) };
  }

  private async handleRequest(request: Request): Promise<Response> {
    if (request.headers.has('origin') || judgeOriginHost(request, []))
      return new Response(null, { status: 403 });
    const url = new URL(request.url);
    if (url.pathname !== PATH || url.search) return new Response(null, { status: 404 });

    const grant = this.authenticate(request);
    const mcpSessionId = request.headers.get('mcp-session-id');
    if (!grant || (mcpSessionId !== null && mcpSessionId !== grant.connection?.transport.sessionId))
      return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
    if (request.method !== 'POST' && request.method !== 'DELETE')
      return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });

    let parsedBody: unknown;
    if (request.method === 'POST') {
      if (!/^application\/json\s*(?:;|$)/i.test(request.headers.get('content-type') ?? ''))
        return new Response(null, { status: 415 });
      const deadline = AbortSignal.timeout(10_000);
      const body = await readBoundedText(request, MAX_BODY_BYTES, deadline);
      if (deadline.aborted) return new Response(null, { status: 408 });
      if (body === null) return new Response(null, { status: 413 });
      try {
        parsedBody = JSON.parse(body);
      } catch {
        return new Response(null, { status: 400 });
      }
    }

    const id = grant.session.getSessionData().id;
    if (this.grants.get(id) !== grant) return new Response(null, { status: 401 });
    const previous = grant.connection;
    if (mcpSessionId === null) {
      if (!isInitializeRequest(parsedBody)) return new Response(null, { status: 400 });
      grant.connection = this.connect(grant);
      await previous?.transport.close();
    }
    const connection = grant.connection;
    if (!connection) return new Response(null, { status: 401 });
    await connection.ready;
    if (
      this.grants.get(id) !== grant ||
      connection !== grant.connection ||
      (mcpSessionId !== null && mcpSessionId !== connection.transport.sessionId)
    )
      return new Response(null, { status: 401 });
    return connection.transport.handleRequest(request, { parsedBody });
  }
}
