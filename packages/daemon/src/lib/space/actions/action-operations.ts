import { z } from 'zod';
import type { OperationDefinition } from '../../operations/registry.ts';
import { defineOperation } from '../../operations/registry.ts';
import type { ActionRegistry, RegisteredAction } from './registry.ts';

const passthroughResult = z.unknown();

export function actionAsOperation(action: RegisteredAction): OperationDefinition {
  return defineOperation({
    name: action.name,
    description: `${action.description} Params: ${action.paramsDoc}`,
    inputSchema: action.paramsSchema,
    resultSchema: passthroughResult,
    execute: async (input) => action.handler(input),
  });
}

export function actionsAsOperations(registry: ActionRegistry): OperationDefinition[] {
  return registry.entries.map(actionAsOperation);
}
