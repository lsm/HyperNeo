import { describe, expect, test, vi } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServerConfig } from '@hyperneo/shared';
import { z } from 'zod';
import { subscribeToStructuredLogs } from '../../../../src/lib/logger';
import {
  instrumentTypedTelemetryAtMcpBoundary,
  type McpTypedTelemetryConfig,
} from '../../../../src/lib/space/tools/mcp-typed-telemetry-boundary.ts';
import { AcpMcpProxyBridge } from '../../../../src/lib/acp/mcp-proxy-bridge.ts';
import type { StructuredLogEvent } from '@hyperneo/shared';

const telemetryConfig: McpTypedTelemetryConfig = {
  spaceId: 'space-1',
  myAgentName: 'agent-1',
  mySessionId: 'session-1',
  taskId: 'task-1',
  workflowRunId: 'run-1',
};

interface ProtocolWithRequestHandlers {
  _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
}

function collectStructuredLogEvents(): { events: StructuredLogEvent[]; unsubscribe: () => void } {
  const events: StructuredLogEvent[] = [];
  const unsubscribe = subscribeToStructuredLogs((event) => events.push(event));
  return { events, unsubscribe };
}

function makeMcpServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  server.registerTool(
    'ping',
    { description: 'Ping', inputSchema: z.object({ value: z.string() }) },
    async (args: { value: string }) => ({
      content: [{ type: 'text' as const, text: `pong ${args.value}` }],
      isError: false,
    })
  );
  return server;
}

function findTypedEvents(events: StructuredLogEvent[], action?: string): StructuredLogEvent[] {
  return events.filter(
    (event) =>
      event.message === 'action.typed' &&
      event.module === 'hyperneo:daemon:space-actions.typed' &&
      (action === undefined || (event.metadata as Record<string, unknown>)?.action === action)
  );
}

function getCallHandler(server: McpServer) {
  return (server.server as unknown as ProtocolWithRequestHandlers)._requestHandlers.get(
    'tools/call'
  );
}

describe('instrumentTypedTelemetryAtMcpBoundary', () => {
  test('emits action.typed before the SDK protocol handler executes a valid call', async () => {
    const mcpServer = makeMcpServer();
    instrumentTypedTelemetryAtMcpBoundary({ instance: mcpServer }, telemetryConfig);

    const { events, unsubscribe } = collectStructuredLogEvents();
    try {
      const handler = getCallHandler(mcpServer);
      const result = await handler?.(
        {
          method: 'tools/call',
          params: { name: 'ping', arguments: { value: 'hello' } },
        },
        {}
      );

      const typed = findTypedEvents(events, 'ping');
      expect(typed).toHaveLength(1);
      expect((typed[0]?.metadata as Record<string, unknown>)?.spaceId).toBe('space-1');
      expect((typed[0]?.metadata as Record<string, unknown>)?.agentName).toBe('agent-1');
      expect(result).toEqual({
        content: [{ type: 'text', text: 'pong hello' }],
        isError: false,
      });
    } finally {
      unsubscribe();
    }
  });

  test('emits action.typed for malformed SDK calls that fail schema validation', async () => {
    const mcpServer = makeMcpServer();
    instrumentTypedTelemetryAtMcpBoundary({ instance: mcpServer }, telemetryConfig);

    const { events, unsubscribe } = collectStructuredLogEvents();
    try {
      const handler = getCallHandler(mcpServer);
      const result = await handler?.(
        {
          method: 'tools/call',
          params: { name: 'ping', arguments: { value: 123 } },
        },
        {}
      );

      expect(findTypedEvents(events, 'ping')).toHaveLength(1);
      expect(result).toMatchObject({ isError: true });
    } finally {
      unsubscribe();
    }
  });

  test('attaches emitTypedTelemetry to each registered tool for ACP proxy calls', async () => {
    const mcpServer = makeMcpServer();
    instrumentTypedTelemetryAtMcpBoundary({ instance: mcpServer }, telemetryConfig);

    expect(
      (
        mcpServer as unknown as {
          _registeredTools: Record<string, { emitTypedTelemetry?: unknown }>;
        }
      )._registeredTools.ping?.emitTypedTelemetry
    ).toBeTypeOf('function');

    const proxy = new AcpMcpProxyBridge({
      'node-agent': { type: 'sdk', instance: mcpServer } as McpServerConfig,
    });

    const { events, unsubscribe } = collectStructuredLogEvents();
    try {
      const result = await proxy.handleLineForTest(
        JSON.stringify({
          token: proxy.token,
          serverName: 'node-agent',
          toolName: 'ping',
          arguments: { value: 'acp' },
        })
      );

      const typed = findTypedEvents(events, 'ping');
      expect(typed).toHaveLength(1);
      expect((typed[0]?.metadata as Record<string, unknown>)?.sessionId).toBe('session-1');
      expect(result).toEqual({
        content: [{ type: 'text', text: 'pong acp' }],
        isError: false,
      });
    } finally {
      unsubscribe();
    }
  });

  test('emits action.typed for malformed ACP calls that fail schema validation', async () => {
    const mcpServer = makeMcpServer();
    instrumentTypedTelemetryAtMcpBoundary({ instance: mcpServer }, telemetryConfig);

    const proxy = new AcpMcpProxyBridge({
      'node-agent': { type: 'sdk', instance: mcpServer } as McpServerConfig,
    });

    const { events, unsubscribe } = collectStructuredLogEvents();
    try {
      const result = await proxy.handleLineForTest(
        JSON.stringify({
          token: proxy.token,
          serverName: 'node-agent',
          toolName: 'ping',
          arguments: { value: 123 },
        })
      );

      expect(findTypedEvents(events, 'ping')).toHaveLength(1);
      expect(result).toMatchObject({ isError: true });
    } finally {
      unsubscribe();
    }
  });

  test('does not throw when the protocol layer is unavailable', () => {
    const mockMcpServer = {
      _registeredTools: {
        ping: { callback: vi.fn() },
      },
    };

    expect(() =>
      instrumentTypedTelemetryAtMcpBoundary(
        { instance: mockMcpServer as unknown as McpServer },
        telemetryConfig
      )
    ).not.toThrow();

    expect(
      (mockMcpServer._registeredTools as { ping?: { emitTypedTelemetry?: unknown } }).ping
        ?.emitTypedTelemetry
    ).toBeTypeOf('function');
  });
});
