import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import type { AcpProxyToolSchema } from './mcp-proxy-bridge.ts';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string } | unknown;
};

type ToolCallParams = {
  name?: string;
  arguments?: unknown;
};

type ProxyCallRequest = {
  token: string;
  serverName: string;
  toolName: string;
  arguments?: unknown;
};

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const MCP_PROTOCOL_VERSION = '2025-11-25';

export function startAcpMcpProxy(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const toolsPath = requiredArg(args, 'toolsPath');
  const tools = JSON.parse(readFileSync(toolsPath, 'utf8')) as AcpProxyToolSchema[];
  const socketPath = requiredArg(args, 'socketPath');
  const serverName = requiredArg(args, 'serverName');
  const token = requiredArg(args, 'token');
  let buffer = '';

  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) void handleJsonRpcLine(line, { socketPath, serverName, token, tools });
      newline = buffer.indexOf('\n');
    }
  });
}

async function handleJsonRpcLine(
  line: string,
  context: {
    socketPath: string;
    serverName: string;
    token: string;
    tools: AcpProxyToolSchema[];
  }
): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch (error) {
    writeResponse(null, undefined, rpcError(-32700, errorMessage(error)));
    return;
  }

  if (request.id === undefined || request.id === null) return;

  try {
    switch (request.method) {
      case 'initialize':
        writeResponse(request.id, {
          protocolVersion: requestedProtocolVersion(request.params) ?? MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: `${context.serverName}-acp-proxy`, version: '1.0.0' },
        });
        return;
      case 'ping':
        writeResponse(request.id, {});
        return;
      case 'tools/list':
        writeResponse(request.id, { tools: context.tools });
        return;
      case 'tools/call': {
        const params = request.params as ToolCallParams;
        if (!params?.name) throw new Error('tools/call missing tool name');
        const result = await callBridge(context.socketPath, {
          token: context.token,
          serverName: context.serverName,
          toolName: params.name,
          arguments: params.arguments ?? {},
        });
        writeResponse(request.id, normalizeToolResult(result));
        return;
      }
      default:
        writeResponse(
          request.id,
          undefined,
          rpcError(-32601, `Method not found: ${request.method}`)
        );
    }
  } catch (error) {
    writeResponse(request.id, undefined, rpcError(-32000, errorMessage(error)));
  }
}

async function callBridge(socketPath: string, request: ProxyCallRequest): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timeoutMs = getCallTimeoutMs();
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`ACP MCP proxy call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let settled = false;
    let response = '';
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      settle(() => {
        const payload = JSON.parse(response.slice(0, newline));
        if (payload && typeof payload === 'object' && 'error' in payload) {
          reject(new Error(String(payload.error)));
        } else {
          resolve(payload);
        }
      });
    });
    socket.once('error', (error) => settle(() => reject(error)));
  });
}

function requestedProtocolVersion(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const protocolVersion = (params as { protocolVersion?: unknown }).protocolVersion;
  return typeof protocolVersion === 'string' && protocolVersion ? protocolVersion : undefined;
}

function getCallTimeoutMs(): number {
  const raw =
    process.env.HYPERNEO_ACP_MCP_PROXY_CALL_TIMEOUT_MS ??
    process.env.NEOKAI_ACP_MCP_PROXY_CALL_TIMEOUT_MS;
  if (!raw) return DEFAULT_CALL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CALL_TIMEOUT_MS;
}

function normalizeToolResult(result: unknown): unknown {
  if (result && typeof result === 'object' && 'content' in result) return result;
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
  };
}

function writeResponse(
  id: string | number | null,
  result?: unknown,
  error?: { code: number; message: string }
): void {
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) })}\n`);
}

function rpcError(code: number, message: string): { code: number; message: string } {
  return { code, message };
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key && value !== undefined) parsed[key] = value;
  }
  return parsed;
}

function requiredArg(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
