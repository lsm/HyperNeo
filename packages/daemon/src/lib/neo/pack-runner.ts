import type { OperationDefinition } from '../operations/registry.ts';

export function validatePackRunner(operation: OperationDefinition): void {
  const runner: unknown = Reflect.get(operation, 'pipelineRunner');
  if (runner === undefined) return;
  const description: unknown =
    typeof runner === 'function' ? Reflect.get(runner, 'pipeline') : null;
  if (
    typeof runner !== 'function' ||
    !description ||
    typeof description !== 'object' ||
    Reflect.get(description, 'name') !== operation.name
  )
    throw new Error(`Invalid pack pipeline runner for ${operation.name}`);
}
