import { mock } from 'bun:test';

mock.module('@anthropic-ai/claude-agent-sdk', () => {
  class MockMcpServer {
    readonly _registeredTools: Record<string, object> = {};

    connect(): void {}
    disconnect(): void {}
  }

  let _toolBatch: Array<{ name: string; def: object }> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function tool(name: string, description: string, inputSchema: any, handler: unknown): object {
    const def = { name, description, inputSchema, handler };
    _toolBatch.push({ name, def });
    return def;
  }

  return {
    query: mock(async () => ({
      interrupt: () => {},
    })),
    interrupt: mock(async () => {}),
    supportedModels: mock(async () => {
      throw new Error('SDK unavailable in unit test');
    }),
    createSdkMcpServer: mock((_options: { name: string; version?: string; tools?: unknown[] }) => {
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
    }),
    tool,
  };
});

import { configureLogger, LogLevel } from '@hyperneo/shared';
import { resetProviderRegistry } from '../../src/lib/providers/registry';

process.env.NODE_ENV = 'test';

resetProviderRegistry();

configureLogger({ level: LogLevel.SILENT });

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;

console.error = () => {};
console.warn = () => {};
console.log = () => {};

(globalThis as unknown as Record<string, unknown>).__originalConsole = {
  error: originalConsoleError,
  warn: originalConsoleWarn,
  log: originalConsoleLog,
};

process.env.ANTHROPIC_API_KEY = '';
process.env.CLAUDE_CODE_OAUTH_TOKEN = '';
process.env.GLM_API_KEY = '';
process.env.ZHIPU_API_KEY = '';
process.env.MINIMAX_API_KEY = '';
process.env.DEEPSEEK_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.KIMI_API_KEY = '';
process.env.MOONSHOT_API_KEY = '';
process.env.HYPERNEO_ACP_COMMAND = '';

delete process.env.ENABLE_TOOL_SEARCH;
delete process.env.ANTHROPIC_MODEL;
delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.API_TIMEOUT_MS;
delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
