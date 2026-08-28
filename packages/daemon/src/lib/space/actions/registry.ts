import type { z } from 'zod';
import type { ActionSafetyClass } from './safety.ts';
import { isActionSafetyClass } from './safety.ts';

export type ActionAutonomyResolver<P> = (params: P) => Promise<number>;

export type ErasedActionAutonomyResolver = (params: unknown) => Promise<number>;

export type ErasedActionHandler = (params: unknown) => Promise<unknown>;

export type ActionTaskIdPreference = 'task_id' | 'task_number';

export interface ActionEntry<P> {
  readonly name: string;
  readonly family: string;
  readonly safetyClass?: ActionSafetyClass;
  readonly description: string;
  readonly paramsDoc: string;
  readonly returnsHint?: string;
  readonly paramsSchema: z.ZodType<P>;
  readonly taskIdPreference?: ActionTaskIdPreference;
  readonly auditRedactKeys?: readonly string[];
  readonly autonomyRequirement?: number | ActionAutonomyResolver<P>;
  readonly handler: (params: P) => Promise<unknown>;
}

export interface ActionDefinition {
  readonly name: string;
  readonly family: string;
  readonly safetyClass?: ActionSafetyClass;
  readonly description: string;
  readonly paramsDoc: string;
  readonly returnsHint?: string;
  readonly paramsSchema: z.ZodType<unknown>;
  readonly taskIdPreference?: ActionTaskIdPreference;
  readonly auditRedactKeys?: readonly string[];
  readonly autonomyRequirement?: number | ErasedActionAutonomyResolver;
  readonly handler: ErasedActionHandler;
}

export type RegisteredAction = Omit<ActionDefinition, 'safetyClass'> & {
  readonly safetyClass: ActionSafetyClass;
};

export function defineAction<P>(entry: ActionEntry<P>): ActionDefinition {
  const { autonomyRequirement, handler, ...rest } = entry;
  if (typeof autonomyRequirement === 'function') {
    return {
      ...rest,
      autonomyRequirement: (params: unknown) => autonomyRequirement(params as P),
      handler: (params: unknown) => handler(params as P),
    };
  }
  return {
    ...rest,
    autonomyRequirement,
    handler: (params: unknown) => handler(params as P),
  };
}

export interface ActionRegistry {
  readonly entries: readonly RegisteredAction[];
  get(name: string): RegisteredAction | undefined;
}

export function createActionRegistry(definitions: readonly ActionDefinition[]): ActionRegistry {
  const problems: string[] = [];
  const firstSeenIndexByName = new Map<string, number>();
  const registered: RegisteredAction[] = [];

  definitions.forEach((definition, index) => {
    const label =
      typeof definition.name === 'string' && definition.name.length > 0
        ? `actions[${index}] ("${definition.name}")`
        : `actions[${index}]`;
    if (typeof definition.name !== 'string' || definition.name.length === 0) {
      problems.push(`${label}: action name must be a non-empty string`);
      return;
    }
    const firstSeenIndex = firstSeenIndexByName.get(definition.name);
    if (firstSeenIndex !== undefined) {
      problems.push(
        `${label}: duplicate action name "${definition.name}" (first defined at actions[${firstSeenIndex}])`
      );
      return;
    }
    firstSeenIndexByName.set(definition.name, index);
    if (!isActionSafetyClass(definition.safetyClass)) {
      problems.push(
        `${label}: unclassified safetyClass (${String(definition.safetyClass)}) — unclassified ` +
          'actions are presumed mutating and rejected by default; classify every entry as one of ' +
          'read, mutate, destructive, human_only'
      );
      return;
    }
    registered.push({ ...definition, safetyClass: definition.safetyClass });
  });

  if (problems.length > 0) {
    throw new Error(
      `createActionRegistry rejected ${problems.length} action(s): ${problems.join('; ')}`
    );
  }

  const byName = new Map(registered.map((action) => [action.name, action]));
  return {
    entries: registered,
    get: (name: string) => byName.get(name),
  };
}
