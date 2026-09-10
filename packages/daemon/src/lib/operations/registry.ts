import type { z } from 'zod';

export interface OperationCaller {
  source: 'rpc' | 'mcp' | 'internal';
  sessionId?: string;
}

export interface OperationEntry<Input, Output> {
  readonly name: string;
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
    if (!/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/.test(definition.name)) {
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
