import { explainNeoRefusal } from '@hyperneo/shared/types/neo-refusals';
import { resolveOperationRegistry } from './registry.ts';
import { z } from 'zod';
import { invokeOperation, type OperationOutcome } from './invoke.ts';
import type { CallerIdentity } from './caller.ts';
import type { OperationRegistrySource } from './registry.ts';

export const OperationMcpInvocationSchema = z.object({
  name: z.string().min(1),
  input: z.looseObject({}).optional(),
});

function mcpResult(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value ?? null) }],
    ...(isError ? { isError: true } : {}),
  };
}

export type OperationRefusal = { operation: string; reason: string };

export function operationRefusal(
  operation: string,
  outcome: OperationOutcome
): OperationRefusal | null {
  if (outcome.kind === 'failed') return { operation, reason: outcome.code };
  const value = outcome.value as { ok?: unknown; accepted?: unknown; reason?: unknown } | null;
  return value &&
    typeof value === 'object' &&
    (value.ok === false || value.accepted === false) &&
    typeof value.reason === 'string'
    ? { operation, reason: value.reason }
    : null;
}

export function createOperationMcpHandler(
  registry: OperationRegistrySource,
  resolveCaller: () => CallerIdentity | Promise<CallerIdentity>,
  recordRefusal: (refusal: OperationRefusal) => void | Promise<void> = () => {}
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
        }
      );
      const refusal = operationRefusal(parsed.data.name, outcome);
      if (refusal) await recordRefusal(refusal);
      return outcome.kind === 'completed'
        ? mcpResult(
            parsed.data.name.startsWith('neo.') ? explainNeoRefusal(outcome.value) : outcome.value
          )
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
