import superpipe, { type PipelineAPI } from 'superpipe';
import type { OperationCaller, OperationDefinition, OperationRegistry } from './registry.ts';

export type OperationFailure = {
  kind: 'failed';
  code: 'unknown_operation' | 'invalid_input' | 'forbidden' | 'execution_failed' | 'invalid_result';
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
  try {
    const parsed = await operation.inputSchema.safeParseAsync(input);
    return parsed.success
      ? { value: { operation, input: parsed.data } }
      : { reason: { kind: 'failed', code: 'invalid_input', message: parsed.error.message } };
  } catch (error) {
    return {
      reason: {
        kind: 'failed',
        code: 'invalid_input',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function isOperationAdmitted(
  _operation: OperationDefinition,
  _caller: OperationCaller
): boolean {
  return true;
}

export function admitOperationCaller(
  prepared: PreparedOperation,
  caller: OperationCaller
): Gate<PreparedOperation> {
  return isOperationAdmitted(prepared.operation, caller)
    ? { value: prepared }
    : {
        reason: {
          kind: 'failed',
          code: 'forbidden',
          message: `Operation ${prepared.operation.name} is not available to this caller`,
        },
      };
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
  try {
    const parsed = await executed.operation.resultSchema.safeParseAsync(executed.result);
    return parsed.success
      ? { value: { kind: 'completed', value: parsed.data } }
      : { reason: { kind: 'failed', code: 'invalid_result', message: parsed.error.message } };
  } catch (error) {
    return {
      reason: {
        kind: 'failed',
        code: 'invalid_result',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export const invokeOperation = (superpipe({})('invoke-operation') as PipelineAPI)
  .input(['registry', 'name', 'input', 'caller'])
  .pipe(resolveOperation, ['registry', 'name'], 'result:invocation')
  .pipe(parseOperationInput, ['invocation', 'input'], 'result:invocation')
  .pipe(admitOperationCaller, ['invocation', 'caller'], 'result:invocation')
  .pipe(executeOperation, ['invocation', 'caller'], 'result:invocation')
  .pipe(validateOperationResult, 'invocation', 'result:invocation')
  .endAsync('invocation') as (
  registry: OperationRegistry,
  name: string,
  input: unknown,
  caller: OperationCaller
) => Promise<OperationOutcome>;
