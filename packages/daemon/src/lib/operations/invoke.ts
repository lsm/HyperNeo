import { isLocalUser } from './caller.ts';
import { normalizeOperationInput } from './normalize-input.ts';
import { operationInputExample } from './input-example.ts';
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

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function suggestOperationNames(registry: OperationRegistry, name: string): string[] {
  const requestedSegments = name.split('.');
  return registry.entries
    .map((entry) => entry.name)
    .filter((candidate) => candidate !== name)
    .map((candidate) => ({
      candidate,
      sharedSegments: candidate.split('.').filter((segment) => requestedSegments.includes(segment))
        .length,
      distance: levenshtein(name, candidate),
    }))
    .filter(({ sharedSegments }) => sharedSegments > 0)
    .sort(
      (a, b) =>
        b.sharedSegments - a.sharedSegments ||
        a.distance - b.distance ||
        (a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0)
    )
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

function unknownOperationMessage(registry: OperationRegistry, name: string): string {
  const suggestions = suggestOperationNames(registry, name);
  return suggestions.length === 0
    ? `Unknown operation: ${name}`
    : `Unknown operation: ${name}. Did you mean: ${suggestions.join(', ')}?`;
}

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
          message: unknownOperationMessage(registry, name),
        },
      };
}

export async function parseOperationInput(
  operation: OperationDefinition,
  input: unknown
): Promise<Gate<PreparedOperation>> {
  try {
    const normalized = await normalizeOperationInput(operation.inputSchema, input);
    const parsed = await operation.inputSchema.safeParseAsync(normalized);
    return parsed.success
      ? { value: { operation, input: parsed.data } }
      : {
          reason: {
            kind: 'failed',
            code: 'invalid_input',
            message: parsed.error.message + (await operationInputExample(operation.inputSchema)),
          },
        };
  } catch (error) {
    return {
      reason: {
        kind: 'failed',
        code: 'invalid_input',
        message:
          (error instanceof Error ? error.message : String(error)) +
          (await operationInputExample(operation.inputSchema)),
      },
    };
  }
}

const DEVICE_OPERATIONS: Record<'relay' | 'daemon', ReadonlySet<string>> = {
  relay: new Set([
    'neo.snapshot',
    'neo.ask.read',
    'neo.ask.history',
    'neo.publication.read',
    'client.list',
  ]),
  daemon: new Set([
    'operations.list',
    'message.send',
    'work.adapters',
    'work.find',
    'work.queue',
    'work.read',
    'work.rename',
    'work.send',
    'work.start',
    'work.status',
    'work.stop',
    'work.withdraw',
  ]),
};

function isDeviceAdmitted(operation: OperationDefinition, caller: OperationCaller): boolean {
  const kind = caller.device?.kind;
  return !kind || kind === 'human' || DEVICE_OPERATIONS[kind].has(operation.name);
}

export function isOperationAdmitted(
  operation: OperationDefinition,
  caller: OperationCaller
): boolean {
  return (
    isDeviceAdmitted(operation, caller) &&
    (operation.policy?.caller !== 'local_user' || isLocalUser(caller))
  );
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
