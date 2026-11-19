import type { AsyncPipelineRunner } from 'superpipe';
import type { OperationCaller, OperationDefinition } from '../operations/registry.ts';

export function retainPackPipeline(
  operation: OperationDefinition,
  runner: AsyncPipelineRunner
): OperationDefinition {
  if (runner.pipeline.name !== operation.name)
    throw new Error(`Pack pipeline name does not match ${operation.name}`);
  const retained = {
    ...operation,
    execute: (input: unknown, caller: OperationCaller) => runner(input, caller),
  };
  Reflect.deleteProperty(retained, 'pipelineRunner');
  return retained;
}
