import { types } from 'node:util';
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

export type AuditedOperation = {
  operation: { name: string; description: string };
  input: unknown;
};

export type OperationAudit = {
  before?: (prepared: Readonly<AuditedOperation>, caller: OperationCaller) => void | Promise<void>;
  after?: (
    prepared: Readonly<AuditedOperation>,
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

const UNREPRESENTABLE = '[unrepresentable]';

type AuditHooks = {
  before?: NonNullable<OperationAudit['before']>;
  after?: NonNullable<OperationAudit['after']>;
};

function resolveAuditHooks(audit?: OperationAudit): AuditHooks {
  try {
    const before = audit?.before;
    const after = audit?.after;
    return {
      before: typeof before === 'function' ? before.bind(audit) : undefined,
      after: typeof after === 'function' ? after.bind(audit) : undefined,
    };
  } catch {
    return {};
  }
}

function readField(target: unknown, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function isProxyBacked(source: object): boolean {
  try {
    return types.isProxy(source);
  } catch {
    return false;
  }
}

function isArrayIndex(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}

function isProjectable(source: object): boolean {
  if (Array.isArray(source) || typeof source === 'function') return true;
  const proto = Object.getPrototypeOf(source);
  return proto === Object.prototype || proto === null;
}

function isolateValue<T>(value: T, seen: WeakMap<object, unknown>): T {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const source = value as object;
  const cached = seen.get(source);
  if (cached) return cached as T;
  if (isProxyBacked(source)) return UNREPRESENTABLE as T;
  if (source instanceof Date) return new Date(Date.prototype.getTime.call(source)) as T;
  if (!isProjectable(source)) return UNREPRESENTABLE as T;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  if (Array.isArray(source)) {
    const copy: unknown[] = [];
    seen.set(source, copy);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) continue;
      const entry = isolateValue(descriptor.value, seen);
      if (isArrayIndex(key)) {
        copy[Number(key)] = entry;
        continue;
      }
      Object.defineProperty(copy, key, {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    copy.length = source.length;
    return copy as T;
  }
  const copy: Record<string, unknown> = {};
  seen.set(source, copy);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    Object.defineProperty(copy, key, {
      value: 'value' in descriptor ? isolateValue(descriptor.value, seen) : UNREPRESENTABLE,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy as T;
}

function cloneValue<T>(value: T): T {
  try {
    return isolateValue(value, new WeakMap<object, unknown>());
  } catch {
    return UNREPRESENTABLE as T;
  }
}

function snapshotPrepared(prepared: PreparedOperation, hooks: AuditHooks): AuditedOperation {
  const auditing = Boolean(hooks.before || hooks.after);
  return {
    operation: { name: prepared.operation.name, description: prepared.operation.description },
    input: auditing ? cloneValue(prepared.input) : prepared.input,
  };
}

function snapshotCaller(caller: OperationCaller): OperationCaller {
  const source = readField(caller, 'source') as OperationCaller['source'];
  const sessionId = readField(caller, 'sessionId');
  return typeof sessionId === 'string' ? { source, sessionId } : { source };
}

function snapshotForHook(prepared: Readonly<AuditedOperation>): Readonly<AuditedOperation> {
  return { operation: { ...prepared.operation }, input: cloneValue(prepared.input) };
}

async function auditBefore(
  prepared: Readonly<AuditedOperation>,
  caller: OperationCaller,
  hooks: AuditHooks
): Promise<void> {
  await runAudited(() => hooks.before?.(snapshotForHook(prepared), snapshotCaller(caller)));
}

const runInvocation = (superpipe({})('invoke-operation') as PipelineAPI)
  .input(['registry', 'name', 'input', 'caller', 'audit'])
  .pipe((audit?: OperationAudit) => resolveAuditHooks(audit), 'audit', 'hooks')
  .pipe(resolveOperation, ['registry', 'name'], 'result:invocation')
  .pipe(parseOperationInput, ['invocation', 'input'], 'result:invocation')
  .pipe(snapshotPrepared, ['invocation', 'hooks'], 'prepared')
  .pipe(
    (callerArg: OperationCaller, hooks: AuditHooks) =>
      hooks.before || hooks.after ? snapshotCaller(callerArg) : callerArg,
    ['caller', 'hooks'],
    'baseCaller'
  )
  .pipe(auditBefore, ['prepared', 'baseCaller', 'hooks'])
  .pipe(executeOperation, ['invocation', 'caller'], 'result:invocation')
  .pipe(validateOperationResult, 'invocation', 'result:invocation')
  .endAsync('{invocation, prepared, baseCaller, hooks}') as (
  registry: OperationRegistry,
  name: string,
  input: unknown,
  caller: OperationCaller,
  audit?: OperationAudit
) => Promise<{
  invocation: OperationOutcome;
  prepared?: Readonly<AuditedOperation>;
  baseCaller?: OperationCaller;
  hooks?: AuditHooks;
}>;

export async function invokeOperation(
  registry: OperationRegistry,
  name: string,
  input: unknown,
  caller: OperationCaller,
  audit?: OperationAudit
): Promise<OperationOutcome> {
  const { invocation, prepared, baseCaller, hooks } = await runInvocation(
    registry,
    name,
    input,
    caller,
    audit
  );
  if (prepared && baseCaller && hooks?.after) {
    await runAudited(() =>
      hooks.after?.(snapshotForHook(prepared), snapshotCaller(baseCaller), cloneValue(invocation))
    );
  }
  return invocation;
}
