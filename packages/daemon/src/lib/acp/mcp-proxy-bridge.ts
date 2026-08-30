import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toJSONSchema, z } from 'zod';
import type { McpServerConfig } from '@hyperneo/shared/sdk';

type RegisteredTool = {
  description?: string;
  inputSchema?:
    | { parse?: (args: unknown) => unknown; parseAsync?: (args: unknown) => Promise<unknown> }
    | unknown;
  callback?: (args: unknown) => unknown;
  handler?: (args: unknown) => unknown;
  emitTypedTelemetry?: (toolName: string) => void;
};

export type AcpProxyToolSchema = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

type ProxiedTool = {
  serverName: string;
  toolName: string;
  handler: (args: unknown) => unknown;
  inputSchema?: RegisteredTool['inputSchema'];
  schema: AcpProxyToolSchema;
  emitTypedTelemetry?: (toolName: string) => void;
};

type ProxyRequest = {
  id?: string;
  token?: string;
  serverName?: string;
  toolName?: string;
  arguments?: unknown;
};

const PROXIED_SERVER_NAMES = new Set([
  'space-agent-tools',
  'space-actions',
  'node-agent',
  'node-agent-tools',
  'agent-memory',
  'db-query',
]);

export class AcpMcpProxyBridge {
  socketPath: string;
  readonly toolsPath: string;
  readonly token = randomUUID();
  readonly tools: AcpProxyToolSchema[];
  private server: Server | null = null;
  private socketDir: string | null = null;
  private readonly activeSockets = new Set<Socket>();
  private readonly toolsPathByServer = new Map<string, string>();
  private toolsByName = new Map<string, ProxiedTool>();

  private readonly ownsExecution?: () => boolean;

  constructor(mcpServers: Record<string, McpServerConfig>, ownsExecution?: () => boolean) {
    const uniqueName = randomUUID();
    this.socketPath = join(tmpdir(), `hyperneo-acp-proxy-${uniqueName}.sock`);
    this.toolsPath = join(tmpdir(), `hyperneo-acp-proxy-tools-${uniqueName}.json`);
    this.ownsExecution = ownsExecution;
    this.tools = this.collectTools(mcpServers);
  }

  getToolsForServer(serverName: string): AcpProxyToolSchema[] {
    return [...this.toolsByName.values()]
      .filter((tool) => tool.serverName === serverName)
      .map((tool) => tool.schema);
  }

  getToolsPathForServer(serverName: string): string | undefined {
    return this.toolsPathByServer.get(serverName);
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.socketDir = await mkdtemp(join(tmpdir(), 'hyperneo-acp-proxy-'));
    await writeFile(this.toolsPath, JSON.stringify(this.tools), { mode: 0o600 });
    for (const serverName of new Set(
      [...this.toolsByName.values()].map((tool) => tool.serverName)
    )) {
      const serverToolsPath = join(this.socketDir, `${serverName}.tools.json`);
      await writeFile(serverToolsPath, JSON.stringify(this.getToolsForServer(serverName)), {
        mode: 0o600,
      });
      this.toolsPathByServer.set(serverName, serverToolsPath);
    }
    if (process.platform === 'win32') {
      this.socketPath = `\\\\.\\pipe\\hyperneo-acp-proxy-${randomUUID()}`;
    } else {
      this.socketPath = join(this.socketDir, 'proxy.sock');
    }

    this.server = createServer((socket) => {
      let buffer = '';
      let closed = false;
      this.activeSockets.add(socket);
      socket.once('close', () => {
        closed = true;
        this.activeSockets.delete(socket);
      });
      socket.on('error', () => {
        closed = true;
      });
      const writeResponse = (payload: unknown) => {
        if (closed || socket.destroyed) return;
        socket.write(`${JSON.stringify(payload)}\n`, (error) => {
          if (error) socket.destroy();
        });
      };
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            this.handleLine(line)
              .then((response) => writeResponse(response))
              .catch((error) =>
                writeResponse({ error: error instanceof Error ? error.message : String(error) })
              );
          }
          newline = buffer.indexOf('\n');
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.socketPath, () => {
        this.server?.off('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.toolsPathByServer.clear();
    if (this.socketDir) {
      await rm(this.socketDir, { recursive: true, force: true }).catch(() => {});
      this.socketDir = null;
    }
    await rm(this.toolsPath, { force: true }).catch(() => {});
  }

  async handleLineForTest(line: string): Promise<unknown> {
    return await this.handleLine(line);
  }

  private async handleLine(line: string): Promise<unknown> {
    const request = JSON.parse(line) as ProxyRequest;
    if (request.token !== this.token) {
      throw new Error('Invalid proxy token');
    }
    if (!request.serverName || !request.toolName) {
      throw new Error('Missing serverName or toolName');
    }
    const key = toolKey(request.serverName, request.toolName);
    const tool = this.toolsByName.get(key);
    if (!tool) {
      throw new Error(`Unknown proxied MCP tool ${request.serverName}.${request.toolName}`);
    }
    if (this.ownsExecution && !this.ownsExecution()) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'The query attempt that issued this tool call was superseded by an automatic retry or a replacement query.',
          },
        ],
      };
    }
    try {
      tool.emitTypedTelemetry?.(tool.toolName);
      const args = await parseToolArgs(tool.inputSchema, request.arguments ?? {});
      if (this.ownsExecution && !this.ownsExecution()) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'The query attempt that issued this tool call was superseded by an automatic retry or a replacement query.',
            },
          ],
        };
      }
      return await tool.handler(args);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  private collectTools(mcpServers: Record<string, McpServerConfig>): AcpProxyToolSchema[] {
    const schemas: AcpProxyToolSchema[] = [];
    for (const [serverName, config] of Object.entries(mcpServers)) {
      if (!shouldProxy(serverName, config)) continue;
      const registeredTools = getRegisteredTools(config);
      for (const [toolName, registered] of Object.entries(registeredTools)) {
        const handler = registered.callback ?? registered.handler;
        if (typeof handler !== 'function') continue;
        const schema = {
          name: toolName,
          description: registered.description,
          inputSchema: toInputJsonSchema(registered.inputSchema),
        };
        schemas.push(schema);
        this.toolsByName.set(toolKey(serverName, toolName), {
          serverName,
          toolName,
          handler,
          inputSchema: registered.inputSchema,
          schema,
          emitTypedTelemetry: registered.emitTypedTelemetry,
        });
      }
    }
    return schemas;
  }
}

export function shouldProxy(serverName: string, config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const server = config as { type?: string; instance?: unknown };
  return !!server.instance && server.type === 'sdk' && PROXIED_SERVER_NAMES.has(serverName);
}

function getRegisteredTools(config: unknown): Record<string, RegisteredTool> {
  const server = config as {
    tools?: Array<RegisteredTool & { name?: string }>;
    instance?: { _registeredTools?: Record<string, RegisteredTool> };
  };
  const registered = server.instance?._registeredTools;
  if (registered && Object.keys(registered).length > 0) return registered;
  return Object.fromEntries(
    (server.tools ?? []).flatMap((tool) => (tool.name ? [[tool.name, tool]] : []))
  );
}

async function parseToolArgs(
  schema: RegisteredTool['inputSchema'],
  args: unknown
): Promise<unknown> {
  if (!schema) return args;
  const zodSchema = isZodSchema(schema) ? schema : z.object(schema as z.core.$ZodShape);
  if ('parseAsync' in zodSchema && typeof zodSchema.parseAsync === 'function') {
    return await zodSchema.parseAsync(args);
  }
  if ('parse' in zodSchema && typeof zodSchema.parse === 'function') {
    return zodSchema.parse(args);
  }
  return args;
}

function toInputJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema) return { type: 'object', properties: {} };
  try {
    const zodSchema = isZodSchema(schema) ? schema : z.object(schema as z.core.$ZodShape);
    return toJSONSchema(zodSchema as Parameters<typeof toJSONSchema>[0]) as Record<string, unknown>;
  } catch {
    return { type: 'object', properties: {} };
  }
}

function isZodSchema(schema: unknown): schema is Parameters<typeof toJSONSchema>[0] {
  return !!schema && typeof schema === 'object' && '~standard' in schema;
}

function toolKey(serverName: string, toolName: string): string {
  return `${serverName}:${toolName}`;
}
