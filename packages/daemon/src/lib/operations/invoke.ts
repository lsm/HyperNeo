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

export type OperationAudit = {
  before?: (prepared: Readonly<PreparedOperation>, caller: OperationCaller) => void;
  after?: (
    prepared: Readonly<PreparedOperation>,
    caller: OperationCaller,
    outcome: Readonly<OperationOutcome>
  ) => void;
};

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

function runAudited(fn: (() => void) | undefined): void {
  try {
    fn?.();
  } catch {}
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value && typeof value === 'object' ? ({ ...value } as T) : value;
  }
}

function snapshotPrepared(prepared: PreparedOperation): Readonly<PreparedOperation> {
  return { operation: prepared.operation, input: cloneValue(prepared.input) };
}

function auditBefore(
  prepared: PreparedOperation,
  caller: OperationCaller,
  audit?: OperationAudit
): void {
  runAudited(() => audit?.before?.(snapshotPrepared(prepared), caller));
}

const runInvocation = (superpipe({})('invoke-operation') as PipelineAPI)
  .input(['registry', 'name', 'input', 'caller', 'audit'])
  .pipe(resolveOperation, ['registry', 'name'], 'result:invocation')
  .pipe(parseOperationInput, ['invocation', 'input'], 'result:invocation')
  .pipe((prepared: PreparedOperation) => prepared, 'invocation', 'prepared')
  .pipe(auditBefore, ['prepared', 'caller', 'audit'])
  .pipe(executeOperation, ['invocation', 'caller'], 'result:invocation')
  .pipe(validateOperationResult, 'invocation', 'result:invocation')
  .endAsync('{invocation, prepared}') as (
  registry: OperationRegistry,
  name: string,
  input: unknown,
  caller: OperationCaller,
  audit?: OperationAudit
) => Promise<{ invocation: OperationOutcome; prepared?: PreparedOperation }>;

export async function invokeOperation(
  registry: OperationRegistry,
  name: string,
  input: unknown,
  caller: OperationCaller,
  audit?: OperationAudit
): Promise<OperationOutcome> {
  const { invocation, prepared } = await runInvocation(registry, name, input, caller, audit);
  if (prepared) {
    runAudited(() => audit?.after?.(snapshotPrepared(prepared), caller, cloneValue(invocation)));
  }
  return invocation;
}
