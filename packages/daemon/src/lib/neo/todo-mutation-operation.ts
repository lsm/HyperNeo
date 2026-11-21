import superpipe, { type PipelineAPI, type SuperPipeFactory } from 'superpipe';
import { neoToolDescription } from '@hyperneo/prompts';
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
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../operations/registry.ts';
import type { ArtifactRefReader } from '../artifacts/read-operations.ts';
import type { NeoPack, NeoTodoCheckResult } from './pack-contract.ts';
import { getDataDir } from '../data-dir.ts';
import { neoEvidencePathRefusal } from './core-todo-checks.ts';
import { readNeoTodoCompletion } from './todo-completion.ts';
import {
  NeoTodoDoneInput,
  TodoResult,
  type NeoTodoControls,
  type WriteNeoTodoHold,
} from './todo-operations.ts';

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
  ['neo.todo.remove', 'remove'],
]);

async function presentMutation(deps: Dependencies, result: Result): Promise<Result> {
  if (!result.ok) return result;
  const [todo] = await deps.project([result.todo]);
  return {
    ok: true,
    todo,
    ...(result.records ? { records: result.records } : {}),
  };
}

function buildTodoMutation(deps: Dependencies, pipeline: ReturnType<SuperPipeFactory>) {
  return (pipeline as PipelineAPI)
    .input(['raw', 'caller'])
    .pipe((raw: Input) => raw, 'raw', 'request')
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
        return 'patch' in plan ? { value: plan } : { reason: await presentMutation(deps, plan) };
      },
      ['input', 'registered'],
      'result:outcome'
    )
    .pipe(
      async (plan: Plan, input: Input) => {
        if (input.kind !== 'edit' || !input.check) return { value: plan };
        const current = await deps.gateway.call(neoTodoReads, 'getTodo', input.todoId);
        const reason = neoEvidencePathRefusal(input.check, current?.check, getDataDir());
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
      async (plan: Plan, input: Input) => {
        const shouldStop =
          input.kind !== 'edit' || (input.hold != null && plan.todo.startedAt !== null);
        const failure = shouldStop ? await deps.stop(plan.todo) : null;
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
          holdStartedAt:
            input.kind === 'edit' && input.hold != null ? plan.todo.startedAt : undefined,
          now: Date.now(),
          registered,
        }),
      ['input', 'outcome', 'completion', 'registered'],
      'outcome'
    )
    .pipe(
      (result: Result, input: Input) =>
        result.ok
          ? { value: result }
          : {
              reason:
                input.kind === 'done' && result.reason.startsWith('card_unanswered:')
                  ? {
                      ...result,
                      reason: `${result.reason} Its session may have stopped; the todo is unchanged.`,
                    }
                  : result,
            },
      ['outcome', 'input'],
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
              todo:
                (await deps.gateway.call(neoTodoReads, 'getTodo', receipt.todo.id)) ?? receipt.todo,
            };
          }
        }
        return receipt;
      },
      ['outcome', 'input'],
      'outcome'
    )
    .pipe((result: Result) => presentMutation(deps, result), 'outcome', 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
}

export function wireNeoTodoMutations(
  createDefinitions: (writeHold: WriteNeoTodoHold) => readonly OperationDefinition[],
  deps: Dependencies
): OperationDefinition[] {
  const mutate = buildTodoMutation(deps, superpipe({})('neo.todo.mutate-through-writer'));
  const done = buildTodoMutation(deps, superpipe({})('neo.todo.done'));
  const definitions = createDefinitions(({ todoId, reason }, caller) =>
    mutate({ todoId, hold: reason, kind: 'edit' }, caller)
  );
  const operations = definitions.map<OperationDefinition>((entry) => {
    const kind = kinds.get(entry.name);
    return kind
      ? {
          ...entry,
          execute: (input, caller) => mutate({ ...(input as object), kind } as Input, caller),
        }
      : entry;
  });
  return [
    ...operations,
    defineOperation({
      name: 'neo.todo.done',
      description: neoToolDescription('neo.todo.done'),
      inputSchema: NeoTodoDoneInput,
      resultSchema: TodoResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: (input, caller) => done({ ...input, kind: 'done' }, caller),
    }),
  ];
}
