import superpipe, { type PipelineAPI } from 'superpipe';
import type { OperationCaller, OperationDefinition, OperationRegistry } from './registry.ts';

export type OperationFailure = {
  kind: 'failed';
  code: 'unknown_operation' | 'invalid_input' | 'execution_failed' | 'invalid_result';
  message: string;
};

export type OperationOutcome = { kind: 'completed'; value: unknown } | OperationFailure;

type Gate<T> = { value: T } | { reason: OperationFailure };
type PreparedOperation = { operation: OperationDefinition; input: unknown };
type ExecutedOperation = { operation: OperationDefinition; result: unknown };

export function resolveOperation(
  registry: OperationRegistry,
  name: string
): Gate<OperationDefinition> {
  const operation = registry.get(name);
  return operation
    ? { value: operation }
    : {
        reason: {
          kind: 'failed',
          code: 'unknown_operation',
          message: `Unknown operation: ${name}`,
        },
      };
}

export async function parseOperationInput(
  operation: OperationDefinition,
  input: unknown
): Promise<Gate<PreparedOperation>> {
  const parsed = await operation.inputSchema.safeParseAsync(input);
  return parsed.success
    ? { value: { operation, input: parsed.data } }
    : { reason: { kind: 'failed', code: 'invalid_input', message: parsed.error.message } };
}

export async function executeOperation(
  prepared: PreparedOperation,
  caller: OperationCaller
): Promise<Gate<ExecutedOperation>> {
  try {
    return {
      value: {
        operation: prepared.operation,
        result: await prepared.operation.execute(prepared.input, caller),
      },
    };
  } catch (error) {
    return {
      reason: {
        kind: 'failed',
        code: 'execution_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function validateOperationResult(
  executed: ExecutedOperation
): Promise<Gate<Extract<OperationOutcome, { kind: 'completed' }>>> {
  const parsed = await executed.operation.resultSchema.safeParseAsync(executed.result);
  return parsed.success
    ? { value: { kind: 'completed', value: parsed.data } }
    : { reason: { kind: 'failed', code: 'invalid_result', message: parsed.error.message } };
}

export const invokeOperation = (superpipe({})('invoke-operation') as PipelineAPI)
  .input(['registry', 'name', 'input', 'caller'])
  .pipe(resolveOperation, ['registry', 'name'], 'result:invocation')
  .pipe(parseOperationInput, ['invocation', 'input'], 'result:invocation')
  .pipe(executeOperation, ['invocation', 'caller'], 'result:invocation')
  .pipe(validateOperationResult, 'invocation', 'result:invocation')
  .endAsync('invocation') as (
  registry: OperationRegistry,
  name: string,
  input: unknown,
  caller: OperationCaller
) => Promise<OperationOutcome>;
