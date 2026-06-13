import { createServer, type Server } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toJSONSchema, z } from 'zod';
import type { McpServerConfig } from '@neokai/shared/sdk';

type RegisteredTool = {
  description?: string;
  inputSchema?: unknown;
  handler?: (args: unknown) => unknown;
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
  schema: AcpProxyToolSchema;
};

type ProxyRequest = {
  id?: string;
  token?: string;
  serverName?: string;
  toolName?: string;
  arguments?: unknown;
};

const PROXIED_SERVER_NAMES = new Set(['space-agent-tools', 'node-agent', 'node-agent-tools']);

export class AcpMcpProxyBridge {
  socketPath: string;
  readonly token = randomUUID();
  readonly tools: AcpProxyToolSchema[];
  private server: Server | null = null;
  private socketDir: string | null = null;
  private toolsByName = new Map<string, ProxiedTool>();

  constructor(mcpServers: Record<string, McpServerConfig>) {
    const uniqueName = randomUUID();
    this.socketPath = join(tmpdir(), `neokai-acp-proxy-${uniqueName}.sock`);
    this.tools = this.collectTools(mcpServers);
  }

  getToolsForServer(serverName: string): AcpProxyToolSchema[] {
    return [...this.toolsByName.values()]
      .filter((tool) => tool.serverName === serverName)
      .map((tool) => tool.schema);
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.socketDir = await mkdtemp(join(tmpdir(), 'neokai-acp-proxy-'));
    this.socketPath = join(this.socketDir, 'proxy.sock');

    this.server = createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            this.handleLine(line)
              .then((response) => socket.write(`${JSON.stringify(response)}\n`))
              .catch((error) =>
                socket.write(
                  `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`
                )
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
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.socketDir) {
      await rm(this.socketDir, { recursive: true, force: true }).catch(() => {});
      this.socketDir = null;
    }
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
    return await tool.handler(request.arguments ?? {});
  }

  private collectTools(mcpServers: Record<string, McpServerConfig>): AcpProxyToolSchema[] {
    const schemas: AcpProxyToolSchema[] = [];
    for (const [serverName, config] of Object.entries(mcpServers)) {
      if (!shouldProxy(serverName, config)) continue;
      const registeredTools = getRegisteredTools(config);
      for (const [toolName, registered] of Object.entries(registeredTools)) {
        if (typeof registered.handler !== 'function') continue;
        const schema = {
          name: toolName,
          description: registered.description,
          inputSchema: toInputJsonSchema(registered.inputSchema),
        };
        schemas.push(schema);
        this.toolsByName.set(toolKey(serverName, toolName), {
          serverName,
          toolName,
          handler: registered.handler,
          schema,
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
  const server = config as { instance?: { _registeredTools?: Record<string, RegisteredTool> } };
  return server.instance?._registeredTools ?? {};
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
