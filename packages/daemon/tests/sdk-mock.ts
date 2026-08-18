import { vi } from 'vitest';

class MockMcpServer {
  readonly _registeredTools: Record<string, object> = {};

  connect(): void {}
  disconnect(): void {}
}

let _toolBatch: Array<{ name: string; def: object }> = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tool(
  name: string,
  description: string,
  inputSchema: any,
  handler: unknown
): object {
  const def = { name, description, inputSchema, handler };
  _toolBatch.push({ name, def });
  return def;
}

export const query = vi.fn(async () => ({
  interrupt: () => {},
}));

export const interrupt = vi.fn(async () => {});

export const supportedModels = vi.fn(async () => {
  throw new Error('SDK unavailable in unit test');
});

export const createSdkMcpServer = vi.fn(
  (_options: { name: string; version?: string; tools?: unknown[] }) => {
    const server = new MockMcpServer();
    for (const { name, def } of _toolBatch) {
      server._registeredTools[name] = def;
    }
    if (Object.keys(server._registeredTools).length === 0 && Array.isArray(_options.tools)) {
      for (const t of _options.tools) {
        const td = t as {
          name?: string;
          description?: string;
          inputSchema?: unknown;
          handler?: unknown;
        };
        if (td.name) {
          server._registeredTools[td.name] = td;
        }
      }
    }
    _toolBatch = [];

    return {
      type: 'sdk' as const,
      name: _options.name,
      version: _options.version ?? '1.0.0',
      tools: _options.tools ?? [],
      instance: server,
    };
  }
);
