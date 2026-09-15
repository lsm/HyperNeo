import { resolveOperationRegistry } from './registry.ts';
import { z } from 'zod';
import { invokeOperation } from './invoke.ts';
import type { OperationAudit } from './invoke.ts';
import type { OperationCaller, OperationRegistrySource } from './registry.ts';

export const OperationMcpInvocationSchema = z.object({
  name: z.string().min(1),
  input: z.unknown().optional(),
});

function mcpResult(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value ?? null) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createOperationMcpHandler(
  registry: OperationRegistrySource,
  resolveCaller: () => Omit<OperationCaller, 'source'> | Promise<Omit<OperationCaller, 'source'>>,
  audit?: OperationAudit
) {
  return async (args: unknown) => {
    const parsed = OperationMcpInvocationSchema.safeParse(args);
    if (!parsed.success) {
      return mcpResult({ code: 'invalid_input', message: parsed.error.message }, true);
    }
    try {
      const caller = await resolveCaller();
      const outcome = await invokeOperation(
        resolveOperationRegistry(registry),
        parsed.data.name,
        parsed.data.input,
        {
          ...caller,
          source: 'mcp',
        },
        audit
      );
      return outcome.kind === 'completed'
        ? mcpResult(outcome.value)
        : mcpResult({ code: outcome.code, message: outcome.message }, true);
    } catch (error) {
      return mcpResult(
        {
          code: 'invocation_failed',
          message: error instanceof Error ? error.message : String(error),
        },
        true
      );
    }
  };
}
