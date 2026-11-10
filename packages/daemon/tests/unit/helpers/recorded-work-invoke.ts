import { readDriverOutcome } from '../../../src/lib/neo/driver-work.ts';
import type { NeoTodoRunnerDeps } from '../../../src/lib/neo/todo-runner.ts';
import type { NeoTodoSessionRepository } from '../../../src/storage/repositories/neo-todo-session-repository.ts';
import type { WorkRef } from '../../../src/lib/drivers/types.ts';

type Invoke = NeoTodoRunnerDeps['invoke'];

export function recordedWorkInvoke(
  inputs: NeoTodoSessionRepository['inputs'],
  invoke: Invoke
): Invoke {
  return async (caller, name, input) => {
    if (name !== 'work.send' && name !== 'work.start') return invoke(caller, name, input);
    const target =
      name === 'work.send'
        ? { verb: 'send' as const, ref: input.ref as WorkRef }
        : { verb: 'start' as const, adapter: String(input.adapter) };
    const id = await inputs.accept(
      (input.todoId as string | undefined) ?? null,
      caller.sessionId ?? 'system',
      target,
      String(input.message),
      Date.now()
    );
    const outcome = await invoke(caller, name, input);
    await inputs.recordOutcome(id, readDriverOutcome(target, outcome), Date.now());
    return outcome;
  };
}
