import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { emitActionTypedEvent } from '../actions/dispatch-telemetry.ts';

export interface McpTypedTelemetryConfig {
  spaceId: string;
  myAgentName?: string | null;
  mySessionId?: string | null;
  taskId?: string;
  workflowRunId?: string;
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
  const protocol = server.instance.server as unknown as ProtocolWithRequestHandlers;
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
