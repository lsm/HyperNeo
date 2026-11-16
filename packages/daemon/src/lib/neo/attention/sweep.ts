import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodoSessionRepository } from '../../../storage/repositories/neo-todo-session-repository.ts';
import { planWorkQueue } from '../../work-queue/capacity.ts';
import type { NeoPack } from '../pack-contract.ts';
import type { NeoAttentionEvent } from './decide.ts';
import { type NeoStepFacts, nextStepOwner } from './owner.ts';

export type NeoStepRow = { todo: NeoTodo; facts: Omit<NeoStepFacts, 'todo'> };
export type NeoStepRead = { todo: NeoTodo; facts: Omit<NeoStepFacts, 'todo' | 'now'> };
type Facts = ReturnType<NeoTodoSessionRepository['neoStepFacts']>;
type Limits = { running: number; perGroup: number };

const owner = ({ todo, facts }: NeoStepRow) => nextStepOwner({ ...facts, todo });

export async function neoPackWaiting(
  packs: readonly NeoPack[],
  todos: readonly NeoTodo[]
): Promise<Set<string>> {
  const waiting = new Set<string>();
  for (const pack of packs) {
    const asked = todos.filter(
      (todo) => !waiting.has(todo.id) && (!todo.check || pack.id === todo.check.pack)
    );
    if (!asked.length || !pack.todos?.waiting) continue;
    for (const id of await pack.todos.waiting(asked)) waiting.add(id);
  }
  return waiting;
}

export function planNeoQueueHolds(facts: Facts, limits: Limits): NeoStepRead[] {
  const { queued } = planWorkQueue(facts.candidates, facts.running, limits);
  return facts.steps.map((row) =>
    queued.includes(row.todo.id) ? { ...row, facts: { ...row.facts, start: 'held' } } : row
  );
}

export async function readNeoSteps(
  facts: Facts,
  deps: { packs(): readonly NeoPack[]; limits(): Limits },
  now: number
): Promise<NeoStepRow[]> {
  const steps = planNeoQueueHolds(facts, deps.limits()).map((row) => ({
    ...row,
    facts: { ...row.facts, now },
  }));
  const waiting = await neoPackWaiting(
    deps.packs(),
    steps.flatMap((row) => (owner(row).owner === 'neo' ? [row.todo] : []))
  );
  return steps.map((row) =>
    waiting.has(row.todo.id) ? { ...row, facts: { ...row.facts, packWaiting: true } } : row
  );
}

export const neoStepOwners = (steps: readonly NeoStepRow[]) =>
  new Map(steps.map((row) => [row.todo.id, owner(row)]));

export function planNeoSweepEvents(
  steps: readonly NeoStepRow[],
  { followUps, unapproved }: Pick<Facts, 'followUps' | 'unapproved'>
): NeoAttentionEvent[] {
  return [
    ...steps.flatMap((row) => {
      const next = owner(row);
      return next.owner === 'neo' && row.todo.approvedAt !== null
        ? [
            {
              kind: 'todo.neo_step',
              subject: { type: 'todo', id: row.todo.id },
              since: next.since,
              facts: {
                title: row.todo.title,
                reason: next.reason,
                requestFrom: row.todo.named?.requestFrom,
                detail:
                  next.reason === 'failed'
                    ? (row.todo.blockedReason ?? row.todo.reason ?? '').replace(/[.。\s]+$/, '')
                    : '',
              },
            },
          ]
        : [];
    }),
    ...followUps.map(({ ask, todo }) => ({
      kind: 'todo.follow_up_missing',
      subject: { type: 'ask', id: ask.id },
      since: todo.finishedAt ?? todo.updatedAt,
      facts: { title: todo.title, todoId: todo.id, askTitle: ask.title },
    })),
    ...unapproved.map((todo) => ({
      kind: 'todo.unworked',
      subject: { type: 'todo', id: todo.id },
      since: todo.updatedAt,
      facts: {
        reason: 'unapproved',
        text: `Todo "${todo.title}" (${todo.id}) cannot start: it was not approved. Review it with neo.todo.read.`,
      },
    })),
  ];
}

export function createNeoAttentionSweep(deps: {
  sessions: NeoTodoSessionRepository;
  packs(): readonly NeoPack[];
  limits(): Limits;
  scan(now: number, waiting: readonly NeoStepRow[]): Promise<readonly NeoAttentionEvent[]>;
  tell(event: NeoAttentionEvent, now: number): Promise<unknown>;
  failed(event: NeoAttentionEvent, error: unknown): void;
}) {
  return (superpipe({})('neo.attention.sweep') as PipelineAPI)
    .input(['now'])
    .pipe(() => deps.sessions.read('neoStepFacts'), 'now', 'facts')
    .pipe((facts: Facts, now: number) => readNeoSteps(facts, deps, now), ['facts', 'now'], 'steps')
    .pipe(
      (now: number, steps: NeoStepRow[]) =>
        deps.scan(
          now,
          steps.filter((row) => owner(row).owner === 'pack')
        ),
      ['now', 'steps'],
      'scanned'
    )
    .pipe(
      (steps: NeoStepRow[], facts: Facts, scanned: readonly NeoAttentionEvent[]) => [
        ...planNeoSweepEvents(steps, facts),
        ...scanned,
      ],
      ['steps', 'facts', 'scanned'],
      'events'
    )
    .pipe(
      async (events: NeoAttentionEvent[], now: number) => {
        for (const event of events)
          await deps.tell(event, now).catch((error) => deps.failed(event, error));
      },
      ['events', 'now'],
      'told'
    )
    .endAsync('told') as (now: number) => Promise<void>;
}
