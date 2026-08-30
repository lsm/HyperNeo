import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { emitStructuredLogEvent } from '../../logger.ts';
import { emitActionTypedEvent } from '../actions/dispatch-telemetry.ts';

export interface McpTypedTelemetryConfig {
  spaceId: string;
  myAgentName?: string | null;
  mySessionId?: string | null;
  taskId?: string;
  workflowRunId?: string;
}

export interface RegisteredToolWithTelemetry {
  callback?: (...args: unknown[]) => unknown;
  handler?: (...args: unknown[]) => unknown;
  emitTypedTelemetry?: (toolName: string) => void;
}

interface McpServerWithRegisteredTools {
  _registeredTools?: Record<string, RegisteredToolWithTelemetry>;
}

interface ProtocolWithRequestHandlers {
  _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
}

interface CallToolRequestShape {
  params?: {
    name?: unknown;
  };
}

export function instrumentTypedTelemetryAtMcpBoundary(
  server: { instance: McpServer },
  config: McpTypedTelemetryConfig
): void {
  const tools = (server.instance as unknown as McpServerWithRegisteredTools)._registeredTools;
  const protocol = (server.instance as unknown as { server?: ProtocolWithRequestHandlers }).server;

  if (!tools && !protocol?._requestHandlers) {
    try {
      emitStructuredLogEvent({
        level: 'warn',
        args: ['typed telemetry boundary has no SDK instrumentation surface'],
        source: 'logger',
        module: 'hyperneo:daemon:space-actions.typed',
        metadata: { spaceId: config.spaceId },
      });
    } catch {}
    return;
  }

  if (tools) {
    for (const tool of Object.values(tools)) {
      if (typeof tool !== 'object' || tool === null) continue;
      if (typeof tool.emitTypedTelemetry === 'function') continue;
      tool.emitTypedTelemetry = (name: string) => {
        try {
          emitActionTypedEvent({
            actionName: name,
            spaceId: config.spaceId,
            agentName: config.myAgentName,
            sessionId: config.mySessionId,
            taskId: config.taskId,
            workflowRunId: config.workflowRunId,
            timestamp: Date.now(),
          });
        } catch {}
      };
    }
  }

  if (!protocol?._requestHandlers) return;

  const original = protocol._requestHandlers.get('tools/call');
  if (!original) return;

  protocol._requestHandlers.set('tools/call', async (request, extra) => {
    const typedRequest = request as CallToolRequestShape;
    const actionName = typedRequest.params?.name;
    if (typeof actionName === 'string') {
      try {
        emitActionTypedEvent({
          actionName,
          spaceId: config.spaceId,
          agentName: config.myAgentName,
          sessionId: config.mySessionId,
          taskId: config.taskId,
          workflowRunId: config.workflowRunId,
          timestamp: Date.now(),
        });
      } catch {}
    }
    return original(request, extra);
  });
}
