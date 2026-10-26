import type { OperationName } from '@hyperneo/shared/types/operation-names';
import type { z } from 'zod';

export type OperationCallerRole =
  | 'neo'
  | 'workflow_worker'
  | 'direct_task_worker'
  | 'long_term_agent'
  | 'universal_read';

export interface OperationCaller {
  readonly consumedInputId?: string;
  readonly source: 'rpc' | 'mcp' | 'internal';
  readonly principal?: string;
  readonly device?: { readonly deviceId: string; readonly kind: 'human' | 'relay' | 'daemon' };
  readonly sessionId?: string;
  readonly spaceId?: string;
  readonly role?: OperationCallerRole;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly hookReplay?: {
    readonly targetNode?: string;
    readonly isFollowUp: boolean;
  };
}

export function isAgentSessionCaller(caller: OperationCaller): boolean {
  return (
    caller.source === 'mcp' &&
    !!caller.sessionId &&
    !!caller.role &&
    caller.role !== 'universal_read'
  );
}

export type OperationSafetyClass = 'read' | 'mutate' | 'destructive' | 'human_only';

export interface OperationPolicy {
  readonly safetyClass: OperationSafetyClass;
  readonly caller?: 'local_user';
  readonly roles?: readonly OperationCallerRole[];
}

export interface OperationEntry<Input, Output> {
  readonly name: OperationName | (string & {});
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly resultSchema: z.ZodType<Output>;
  readonly policy?: OperationPolicy;
  readonly execute: (input: Input, caller: OperationCaller) => Promise<Output>;
}

export type OperationDefinition = OperationEntry<unknown, unknown>;

export function defineOperation<Input, Output>(
  entry: OperationEntry<Input, Output>
): OperationDefinition {
  const { execute, ...definition } = entry;
  return {
    ...definition,
    execute: (input, caller) => execute(input as Input, caller),
  };
}

export interface OperationRegistry {
  readonly entries: readonly OperationDefinition[];
  get(name: string): OperationDefinition | undefined;
}

export function createOperationRegistry(
  definitions: readonly OperationDefinition[]
): OperationRegistry {
  const byName = new Map<string, OperationDefinition>();
  for (const definition of definitions) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*$/.test(definition.name)) {
      throw new Error(`Invalid operation name: ${definition.name}`);
    }
    if (byName.has(definition.name)) {
      throw new Error(`Duplicate operation name: ${definition.name}`);
    }
    byName.set(definition.name, Object.freeze({ ...definition }));
  }
  return {
    entries: Object.freeze([...byName.values()]),
    get: (name) => byName.get(name),
  };
}

export type OperationRegistryProvider = () => OperationRegistry;
export type OperationRegistrySource = OperationRegistry | OperationRegistryProvider;

export function resolveOperationRegistry(source: OperationRegistrySource): OperationRegistry {
  return typeof source === 'function' ? source() : source;
}
