import type { AsyncPipelineRunner } from 'superpipe';
import type { OperationCaller, OperationDefinition } from '../operations/registry.ts';
import type { Rejection } from './admission.ts';

const retainedNames = new WeakMap<OperationDefinition['execute'], string>();

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
  retainedNames.set(retained.execute, operation.name);
  Reflect.deleteProperty(retained, 'pipelineRunner');
  return retained;
}

export function guardRetainedPackPipeline(
  { execute, name }: OperationDefinition,
  admit: (
    caller: OperationCaller,
    name: string
  ) => { value: OperationCaller } | { reason: Rejection }
): OperationDefinition['execute'] | undefined {
  if (retainedNames.get(execute) !== name) return undefined;
  return async (input, caller) => {
    const admission = admit(caller, name);
    return 'reason' in admission ? admission.reason : execute(input, admission.value);
  };
}
