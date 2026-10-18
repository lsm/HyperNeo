import type { createOperationMcpHandler } from '../../src/lib/operations/mcp-adapter';

type InvokeHandler = ReturnType<typeof createOperationMcpHandler>;

interface InvokeTool {
  description: string;
  inputSchema: unknown;
  handler: InvokeHandler;
}

export function operationInvokeTool(server: { instance: unknown }): InvokeTool {
  return (server.instance as { _registeredTools: Record<string, InvokeTool> })._registeredTools
    .invoke;
}

export function operationInvoke(server: {
  instance: unknown;
}): (args: unknown, extra?: unknown) => ReturnType<InvokeHandler> {
  const { handler } = operationInvokeTool(server);
  return (args) => handler(args);
}
