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
  before?: (prepared: Readonly<PreparedOperation>, caller: OperationCaller) => void | Promise<void>;
  after?: (
    prepared: Readonly<PreparedOperation>,
    caller: OperationCaller,
    outcome: Readonly<OperationOutcome>
  ) => void | Promise<void>;
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

async function runAudited(fn: (() => void | Promise<void>) | undefined): Promise<void> {
  try {
    await fn?.();
  } catch {}
}

function isolateValue<T>(value: T, seen: WeakMap<object, unknown>): T {
  if (!value || typeof value !== 'object') return value;
  const source = value as object;
  const cached = seen.get(source);
  if (cached) return cached as T;
  if (source instanceof Date) return new Date(source.getTime()) as T;
  if (Array.isArray(source)) {
    const copy: unknown[] = [];
    seen.set(source, copy);
    for (const item of source) copy.push(isolateValue(item, seen));
    return copy as T;
  }
  const copy: Record<string, unknown> = {};
  seen.set(source, copy);
  for (const [key, item] of Object.entries(source)) copy[key] = isolateValue(item, seen);
  return copy as T;
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return isolateValue(value, new WeakMap<object, unknown>());
  }
}

function snapshotPrepared(prepared: PreparedOperation): Readonly<PreparedOperation> {
  return { operation: prepared.operation, input: cloneValue(prepared.input) };
}

function hasAuditHooks(audit?: OperationAudit): boolean {
  return Boolean(audit?.before || audit?.after);
}

function snapshotCaller(caller: OperationCaller): OperationCaller {
  return { ...caller };
}

async function auditBefore(
  prepared: Readonly<PreparedOperation>,
  baseCaller: OperationCaller,
  audit?: OperationAudit
): Promise<void> {
  await runAudited(() => audit?.before?.(snapshotPrepared(prepared), snapshotCaller(baseCaller)));
}

const runInvocation = (superpipe({})('invoke-operation') as PipelineAPI)
  .input(['registry', 'name', 'input', 'caller', 'audit'])
  .pipe(resolveOperation, ['registry', 'name'], 'result:invocation')
  .pipe(parseOperationInput, ['invocation', 'input'], 'result:invocation')
  .pipe(
    (prepared: PreparedOperation, audit?: OperationAudit) =>
      hasAuditHooks(audit) ? snapshotPrepared(prepared) : prepared,
    ['invocation', 'audit'],
    'prepared'
  )
  .pipe(
    (callerArg: OperationCaller, audit?: OperationAudit) =>
      hasAuditHooks(audit) ? snapshotCaller(callerArg) : callerArg,
    ['caller', 'audit'],
    'baseCaller'
  )
  .pipe(auditBefore, ['prepared', 'baseCaller', 'audit'])
  .pipe(executeOperation, ['invocation', 'caller'], 'result:invocation')
  .pipe(validateOperationResult, 'invocation', 'result:invocation')
  .endAsync('{invocation, prepared, baseCaller}') as (
  registry: OperationRegistry,
  name: string,
  input: unknown,
  caller: OperationCaller,
  audit?: OperationAudit
) => Promise<{
  invocation: OperationOutcome;
  prepared?: Readonly<PreparedOperation>;
  baseCaller?: OperationCaller;
}>;

export async function invokeOperation(
  registry: OperationRegistry,
  name: string,
  input: unknown,
  caller: OperationCaller,
  audit?: OperationAudit
): Promise<OperationOutcome> {
  const { invocation, prepared, baseCaller } = await runInvocation(
    registry,
    name,
    input,
    caller,
    audit
  );
  if (prepared && baseCaller) {
    await runAudited(() =>
      audit?.after?.(snapshotPrepared(prepared), snapshotCaller(baseCaller), cloneValue(invocation))
    );
  }
  return invocation;
}
