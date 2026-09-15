import type { OperationName } from '@hyperneo/shared/types/operation-names';
import type { z } from 'zod';

export type OperationCallerRole =
  | 'ad_hoc_member'
  | 'workflow_worker'
  | 'direct_task_worker'
  | 'long_term_agent'
  | 'universal_read'
  | 'legacy_task_agent'
  | 'outside_space';

export interface OperationCaller {
  readonly source: 'rpc' | 'mcp' | 'internal';
  readonly sessionId?: string;
  readonly spaceId?: string;
  readonly role?: OperationCallerRole;
  readonly agentId?: string;
  readonly agentName?: string;
}

export interface OperationEntry<Input, Output> {
  readonly name: OperationName | (string & {});
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly resultSchema: z.ZodType<Output>;
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
