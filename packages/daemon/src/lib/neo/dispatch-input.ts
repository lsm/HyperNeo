import superpipe, { type PipelineAPI } from 'superpipe';
import type { WorkDeliveryInputRepository } from '../../storage/repositories/work-delivery-input-repository.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { type NeoDriverTarget, readDriverOutcome } from './driver-work.ts';

type Target = Extract<NeoDriverTarget, { verb: 'start' | 'send' }>;
type Call = { name: 'work.start' | 'work.send'; input: Record<string, unknown> };
type Outcome = ReturnType<typeof readDriverOutcome>;
type Invoke = (
  caller: OperationCaller,
  name: string,
  input: Record<string, unknown>
) => Promise<OperationOutcome>;

export const dispatchNeoInput = (superpipe({})('neo.dispatch-input') as PipelineAPI)
  .input(['inputs', 'todoId', 'from', 'target', 'call', 'invoke', 'caller'])
  .pipe(
    (
      inputs: WorkDeliveryInputRepository,
      todoId: string,
      from: string,
      target: Target,
      call: Call
    ) => inputs.accept(todoId, from, target, String(call.input.message), Date.now()),
    ['inputs', 'todoId', 'from', 'target', 'call'],
    'inputId'
  )
  .pipe(
    async (target: Target, call: Call, invoke: Invoke, caller: OperationCaller) =>
      readDriverOutcome(target, await invoke(caller, call.name, call.input)),
    ['target', 'call', 'invoke', 'caller'],
    'outcome'
  )
  .pipe(
    async (inputs: WorkDeliveryInputRepository, inputId: string, outcome: Outcome) => {
      await inputs.recordOutcome(inputId, outcome, Date.now());
      return outcome;
    },
    ['inputs', 'inputId', 'outcome'],
    'outcome'
  )
  .endAsync('outcome') as (
  inputs: WorkDeliveryInputRepository,
  todoId: string,
  from: string,
  target: Target,
  call: Call,
  invoke: Invoke,
  caller: OperationCaller
) => Promise<Outcome>;
