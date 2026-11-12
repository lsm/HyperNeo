import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import type { RunDbOp } from '../../storage/db-gateway/db-op.ts';
import { neoTodoMutationReads } from '../../storage/repositories/neo-todo-mutation-planning.ts';
import { neoTodoMutations } from '../../storage/repositories/neo-todo-mutation-commit.ts';
import {
  neoTodoReads,
  type NeoTodoPatch,
} from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { OperationCaller, OperationDefinition } from '../operations/registry.ts';
import type { ArtifactRefReader } from '../artifacts/read-operations.ts';
import type { NeoPack, NeoTodoCheckResult } from './pack-contract.ts';
import { todoEvidenceFile } from '../work-locations.ts';
import { neoEvidenceRefusal, withAssignedEvidence } from './core-todo-checks.ts';
import { readNeoTodoCompletion, requireNeoTodoCloseStarted } from './todo-completion.ts';
import type { NeoTodoControls } from './todo-operations.ts';
import { neoTodoRepository } from './pack-contract.ts';

type Input = Parameters<InstanceType<typeof neoTodoMutationReads.Repository>['plan']>[0];
type Plan = { todo: NeoTodo; patch: NeoTodoPatch; records?: string[] };
type Result = ReturnType<typeof neoTodoMutations.run>;
type Receipt = Extract<Result, { ok: true }>;
interface Dependencies {
  gateway: DbGateway;
  write: RunDbOp;
  packs(): readonly NeoPack[];
  artifact: ArtifactRefReader;
  userFolder: string;
  stop(todo: NeoTodo): Promise<string | null>;
  resolveTarget: NeoTodoControls['resolveTarget'];
  advance(): Promise<unknown>;
  changed(): void;
  project<T extends NeoTodo>(todos: readonly T[]): Promise<T[]>;
}
const kinds = new Map<string, Input['kind']>([
  ['neo.todo.edit', 'edit'],
  ['neo.todo.hold', 'edit'],
  ['neo.todo.close', 'close'],
  ['neo.todo.done', 'done'],
  ['neo.todo.remove', 'remove'],
]);

const holdAsEdit = (name: string, input: unknown): object => {
  if (name !== 'neo.todo.hold') return input as object;
  const { todoId, reason } = input as { todoId: string; reason: string | null };
  return { todoId, hold: reason };
};

export function wireNeoTodoMutations(
  definitions: readonly OperationDefinition[],
  deps: Dependencies
): OperationDefinition[] {
  const present = (superpipe({})('neo.todo.present-mutation') as PipelineAPI)
    .input(['result'])
    .pipe(
      (result: Result) => (result.ok ? { value: result } : { reason: result }),
      'result',
      'result:outcome'
    )
    .pipe(
      async (receipt: Receipt) => {
        const [todo, ...todos] = await deps.project([receipt.todo, ...receipt.todos]);
        return {
          ok: true as const,
          todo,
          todos,
          ...(receipt.records ? { records: receipt.records } : {}),
        };
      },
      'outcome',
      'outcome'
    )
    .endAsync('outcome') as (result: Result) => Promise<Result>;
  const mutate = (superpipe({})('neo.todo.mutate-through-writer') as PipelineAPI)
    .input(['raw', 'caller'])
    .pipe(
      (raw: Input): Input =>
        raw.kind === 'edit' && raw.check
          ? { ...raw, check: withAssignedEvidence(raw.check, todoEvidenceFile(raw.todoId)) }
          : raw,
      'raw',
      'request'
    )
    .pipe(
      async (request: Input) => {
        if (request.kind !== 'edit' || request.target?.verb !== 'send') return { value: request };
        const resolved = await deps.resolveTarget(request.target.ref);
        return 'reason' in resolved
          ? { reason: resolved.reason }
          : {
              value: {
                ...request,
                target: { ...request.target, ref: resolved.value },
                workerRemotes: resolved.workerRemotes,
              },
            };
      },
      'request',
      'result:outcome'
    )
    .pipe((outcome: Input) => outcome, 'outcome', 'input')
    .pipe(
      (input: Input, caller: OperationCaller) =>
        input.kind === 'edit'
          ? (input.artifacts ?? []).map((ref) => deps.artifact(ref.artifactId, caller))
          : [],
      ['input', 'caller'],
      'registered'
    )
    .pipe(
      async (input: Input, registered: readonly (ArtifactRef | null)[]) => {
        const plan = await deps.gateway.call(
          neoTodoMutationReads,
          'plan',
          input,
          Date.now(),
          registered
        );
        return 'patch' in plan ? { value: plan } : { reason: plan };
      },
      ['input', 'registered'],
      'result:outcome'
    )
    .pipe(
      async (plan: Plan, input: Input) => {
        if (input.kind !== 'edit' || !input.check) return { value: plan };
        const current = await deps.gateway.call(neoTodoReads, 'getTodo', input.todoId);
        const ask = await deps.gateway.call(neoTodoReads, 'getAsk', plan.todo.askId);
        const repo = neoTodoRepository(
          { check: input.check, named: plan.todo.named, target: input.target },
          deps.packs(),
          { ask, todo: current }
        );
        const reason = neoEvidenceRefusal(input.check, repo, deps.userFolder, current?.check);
        return reason ? { reason: { ok: false as const, reason } } : { value: plan };
      },
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      (plan: Plan, input: Input) =>
        plan.patch.state === 'done' && input.kind !== 'done'
          ? readNeoTodoCompletion(deps.packs(), plan.todo)
          : null,
      ['outcome', 'input'],
      'completion'
    )
    .pipe(
      (plan: Plan, input: Input, completion: NeoTodoCheckResult | null) =>
        input.kind === 'close' ? requireNeoTodoCloseStarted(plan, completion) : { value: plan },
      ['outcome', 'input', 'completion'],
      'result:outcome'
    )
    .pipe(
      async (plan: Plan, input: Input) => {
        const failure = input.kind === 'edit' ? null : await deps.stop(plan.todo);
        return failure
          ? {
              reason: {
                ok: false as const,
                reason: `${failure}; the todo is unchanged, its session may still run.`,
              },
            }
          : { value: plan };
      },
      ['outcome', 'input'],
      'result:outcome'
    )
    .pipe(
      (
        input: Input,
        plan: Plan,
        completion: NeoTodoCheckResult | null,
        registered: readonly (ArtifactRef | null)[]
      ) =>
        deps.write(neoTodoMutations, {
          input,
          checked: { check: plan.todo.check, result: completion },
          now: Date.now(),
          registered,
        }),
      ['input', 'outcome', 'completion', 'registered'],
      'outcome'
    )
    .pipe(
      (result: Result) => (result.ok ? { value: result } : { reason: result }),
      'outcome',
      'result:outcome'
    )
    .pipe(
      async (receipt: Receipt, input: Input) => {
        if ('startNext' in receipt) {
          deps.changed();
          if (receipt.startNext || (input.kind === 'edit' && input.instruction)) {
            await deps.advance();
            receipt = {
              ...receipt,
              todos: await deps.gateway.call(neoTodoReads, 'listTodosForAsks', [
                receipt.todo.askId,
              ]),
            };
          }
        }
        return receipt;
      },
      ['outcome', 'input'],
      'outcome'
    )
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return definitions.map((entry) => {
    const kind = kinds.get(entry.name);
    return kind
      ? {
          ...entry,
          execute: (input, caller) =>
            mutate({ ...holdAsEdit(entry.name, input), kind } as Input, caller).then(present),
        }
      : entry;
  });
}
