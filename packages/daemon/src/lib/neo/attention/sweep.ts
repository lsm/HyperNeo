import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodoSessionRepository } from '../../../storage/repositories/neo-todo-session-repository.ts';
import { planWorkQueue } from '../../work-queue/capacity.ts';
import type { NeoPack } from '../pack-contract.ts';
import type { NeoAttentionEvent } from './decide.ts';
import { type NeoStepFacts, nextStepOwner } from './owner.ts';

export type NeoStepRow = { todo: NeoTodo; facts: Omit<NeoStepFacts, 'todo'> };
type Facts = ReturnType<NeoTodoSessionRepository['neoStepFacts']>;
type Limits = { running: number; perGroup: number };

const owner = ({ todo, facts }: NeoStepRow) => nextStepOwner({ ...facts, todo });

export async function neoPackWaits(packs: readonly NeoPack[], todo: NeoTodo): Promise<boolean> {
  for (const pack of packs)
    if ((!todo.check || pack.id === todo.check.pack) && (await pack.todos?.waiting?.(todo)))
      return true;
  return false;
}

export function planNeoQueueHolds(facts: Facts, limits: Limits): NeoStepRow[] {
  const { queued } = planWorkQueue(facts.candidates, facts.running, limits);
  return facts.steps.map((row) =>
    queued.includes(row.todo.id) ? { ...row, facts: { ...row.facts, start: 'held' } } : row
  );
}

export function planNeoSweepEvents(
  steps: readonly NeoStepRow[],
  { followUps, unapproved }: Pick<Facts, 'followUps' | 'unapproved'>
): NeoAttentionEvent[] {
  return [
    ...steps.flatMap((row) => {
      const next = owner(row);
      return next.owner === 'neo'
        ? [
            {
              kind: 'todo.neo_step',
              subject: { type: 'todo', id: row.todo.id },
              since: next.since,
              facts: {
                title: row.todo.title,
                reason: next.reason,
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
  tell(event: NeoAttentionEvent, now: number): Promise<unknown>;
  failed(event: NeoAttentionEvent, error: unknown): void;
}) {
  return (superpipe({})('neo.attention.sweep') as PipelineAPI)
    .input(['now'])
    .pipe(() => deps.sessions.read('neoStepFacts'), 'now', 'facts')
    .pipe((facts: Facts) => planNeoQueueHolds(facts, deps.limits()), 'facts', 'queued')
    .pipe(
      (steps: NeoStepRow[]) =>
        Promise.all(
          steps.map(async (row) =>
            owner(row).owner === 'neo' && (await neoPackWaits(deps.packs(), row.todo))
              ? { ...row, facts: { ...row.facts, packWaiting: true } }
              : row
          )
        ),
      'queued',
      'steps'
    )
    .pipe(
      (steps: NeoStepRow[], facts: Facts) => planNeoSweepEvents(steps, facts),
      ['steps', 'facts'],
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
