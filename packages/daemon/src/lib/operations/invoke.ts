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

export type AuditedCaller = {
  source?: OperationCaller['source'];
  sessionId?: string;
};

export type OperationAudit = {
  before?: (prepared: Readonly<AuditedOperation>, caller: AuditedCaller) => void | Promise<void>;
  after?: (
    prepared: Readonly<AuditedOperation>,
    caller: AuditedCaller,
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
const MAX_SNAPSHOT_DEPTH = 200;

type AuditHooks = {
  before?: NonNullable<OperationAudit['before']>;
  after?: NonNullable<OperationAudit['after']>;
};

function resolveAuditHook<K extends keyof OperationAudit>(
  audit: OperationAudit | undefined,
  key: K
): AuditHooks[K] {
  try {
    const hook = audit?.[key];
    return typeof hook === 'function'
      ? (Function.prototype.bind.call(hook, audit) as AuditHooks[K])
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveAuditHooks(audit?: OperationAudit): AuditHooks {
  return {
    before: resolveAuditHook(audit, 'before'),
    after: resolveAuditHook(audit, 'after'),
  };
}

function isProxyBacked(source: object): boolean {
  try {
    return types.isProxy(source);
  } catch {
    return false;
  }
}

function isDateValue(source: object): boolean {
  try {
    return types.isDate(source);
  } catch {
    return false;
  }
}

function projectEnumerableData(
  descriptors: Record<string | symbol, PropertyDescriptor>,
  target: object,
  seen: WeakMap<object, unknown>,
  depth: number
): void {
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as string];
    if (!descriptor.enumerable) continue;
    Object.defineProperty(target, key, {
      value:
        'value' in descriptor ? isolateValue(descriptor.value, seen, depth + 1) : UNREPRESENTABLE,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

function hasInternalSlots(source: object): boolean {
  try {
    return (
      types.isMap(source) ||
      types.isSet(source) ||
      types.isWeakMap(source) ||
      types.isWeakSet(source) ||
      types.isPromise(source) ||
      types.isRegExp(source) ||
      types.isNativeError(source) ||
      types.isBoxedPrimitive(source) ||
      types.isArrayBuffer(source) ||
      types.isSharedArrayBuffer(source) ||
      types.isArrayBufferView(source) ||
      types.isGeneratorObject(source) ||
      types.isModuleNamespaceObject(source)
    );
  } catch {
    return true;
  }
}

function isPlatformBranded(source: object): boolean {
  let cursor: unknown = Object.getPrototypeOf(source);
  try {
    while (cursor && (typeof cursor === 'object' || typeof cursor === 'function')) {
      if (isProxyBacked(cursor as object)) return true;
      if (Object.getOwnPropertyDescriptor(cursor, Symbol.toStringTag)) return true;
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch {
    return true;
  }
  return false;
}

function isProjectable(source: object): boolean {
  if (typeof source === 'function') return false;
  if (Array.isArray(source)) return true;
  if (hasInternalSlots(source)) return false;
  const proto = Object.getPrototypeOf(source);
  if (proto === Object.prototype || proto === null) return true;
  return !isPlatformBranded(source);
}

function isolateValue<T>(value: T, seen: WeakMap<object, unknown>, depth: number): T {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (depth >= MAX_SNAPSHOT_DEPTH) return UNREPRESENTABLE as T;
  const source = value as object;
  const cached = seen.get(source);
  if (cached) return cached as T;
  if (isProxyBacked(source)) return UNREPRESENTABLE as T;
  if (isDateValue(source)) {
    const detached = new Date(Date.prototype.getTime.call(source as Date));
    seen.set(source, detached);
    projectEnumerableData(Object.getOwnPropertyDescriptors(source), detached, seen, depth);
    return detached as T;
  }
  if (!isProjectable(source)) return UNREPRESENTABLE as T;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  if (Array.isArray(source)) {
    const copy: unknown[] = [];
    seen.set(source, copy);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as string];
      if (!descriptor.enumerable) continue;
      const entry =
        'value' in descriptor ? isolateValue(descriptor.value, seen, depth + 1) : UNREPRESENTABLE;
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
  const copy = Object.create(null) as Record<string | symbol, unknown>;
  seen.set(source, copy);
  projectEnumerableData(descriptors, copy, seen, depth);
  return copy as T;
}

function cloneValue<T>(value: T): T {
  try {
    return isolateValue(value, new WeakMap<object, unknown>(), 0);
  } catch {
    return UNREPRESENTABLE as T;
  }
}

function readMetadataField(operation: OperationDefinition, key: string): string {
  const value = readDataField(operation, key);
  return typeof value === 'string' ? value : UNREPRESENTABLE;
}

function snapshotPrepared(
  prepared: PreparedOperation,
  hooks: AuditHooks
): AuditedOperation | undefined {
  if (!hooks.before && !hooks.after) return undefined;
  return {
    operation: {
      name: readMetadataField(prepared.operation, 'name'),
      description: readMetadataField(prepared.operation, 'description'),
    },
    input: cloneValue(prepared.input),
  };
}

function readDataField(target: unknown, key: string): unknown {
  let cursor: unknown = target;
  try {
    while (cursor && (typeof cursor === 'object' || typeof cursor === 'function')) {
      if (isProxyBacked(cursor as object)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch {}
  return undefined;
}

function snapshotCaller(caller: OperationCaller): AuditedCaller {
  if (!caller || (typeof caller !== 'object' && typeof caller !== 'function')) return {};
  if (isProxyBacked(caller)) return {};
  const source = readDataField(caller, 'source') as OperationCaller['source'];
  const sessionId = readDataField(caller, 'sessionId');
  return typeof sessionId === 'string' ? { source, sessionId } : { source };
}

function snapshotForHook(prepared: Readonly<AuditedOperation>): Readonly<AuditedOperation> {
  return { operation: { ...prepared.operation }, input: cloneValue(prepared.input) };
}

async function auditBefore(
  prepared: Readonly<AuditedOperation>,
  caller: AuditedCaller,
  hooks: AuditHooks
): Promise<void> {
  await runAudited(() => hooks.before?.(snapshotForHook(prepared), { ...caller }));
}

const runInvocation = (superpipe({})('invoke-operation') as PipelineAPI)
  .input(['registry', 'name', 'input', 'caller', 'audit'])
  .pipe((audit?: OperationAudit) => resolveAuditHooks(audit), 'audit', 'hooks')
  .pipe(resolveOperation, ['registry', 'name'], 'result:invocation')
  .pipe(parseOperationInput, ['invocation', 'input'], 'result:invocation')
  .pipe(snapshotPrepared, ['invocation', 'hooks'], 'prepared')
  .pipe(
    (callerArg: OperationCaller, hooks: AuditHooks) =>
      hooks.before || hooks.after ? snapshotCaller(callerArg) : undefined,
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
  baseCaller?: AuditedCaller;
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
      hooks.after?.(snapshotForHook(prepared), { ...baseCaller }, cloneValue(invocation))
    );
  }
  return invocation;
}
