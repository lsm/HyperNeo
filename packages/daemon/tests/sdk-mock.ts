/**
 * Mock for `@anthropic-ai/claude-agent-sdk` used in unit tests.
 *
 * The daemon's vitest config aliases the real SDK specifier to this module so
 * that (a) unit tests never make real API calls and (b) tests can inspect the
 * MCP tool surface (`server.instance._registeredTools`), which the real
 * `McpServer` class keeps private. Mirrors the historical bun:test
 * `mock.module('@anthropic-ai/claude-agent-sdk', …)` setup in
 * `tests/unit/setup.ts`.
 *
 * Individual test files that need different behaviour use `vi.mock()` at the
 * top of their own file to override this default.
 */

import { vi } from 'vitest';

class MockMcpServer {
  readonly _registeredTools: Record<string, object> = {};

  connect(): void {}
  disconnect(): void {}
}

// Per-call tool capture: tool() is called with (name, description,
// inputSchema, handler); we store defs here keyed by name. createSdkMcpServer
// drains the batch into the server instance and resets so subsequent servers
// start clean.
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
    // Fallback: if _toolBatch was empty, recover tool defs from the caller's
    // `tools` option (each element is tool()'s return value).
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
