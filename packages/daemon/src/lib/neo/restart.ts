import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';

export type NeoRestartDeps = {
  open: () => Promise<string>;
  clear: (sessionId: string) => Promise<void>;
  note: (sessionId: string, text: string) => Promise<void>;
  entries: () => NeoAskEntry[] | Promise<NeoAskEntry[]>;
};

const NEO_STATE_NOTE_ASKS = 50;

export function neoStateNote(entries: readonly NeoAskEntry[]): string {
  const asks = entries.slice(0, NEO_STATE_NOTE_ASKS).map(({ ask, state, todos, questions }) => ({
    id: ask.id,
    title: ask.title,
    state,
    todos: todos
      .filter((todo) => todo.state !== 'removed')
      .map((todo) => ({
        id: todo.id,
        title: todo.title,
        state: todo.state,
        status: todo.status,
        doneWhen: todo.doneWhen,
        worker: todo.worker ?? null,
      })),
    questions: questions
      .filter((question) => question.state === 'open')
      .map((question) => ({ id: question.id, text: question.text })),
  }));
  return [
    'Your context starts here. The open asks, their todos and the unanswered questions, read from the database:',
    JSON.stringify(asks),
    ...(entries.length > asks.length
      ? [
          `${entries.length - asks.length} more open asks are left out; read them with neo.snapshot.`,
        ]
      : []),
    'Anything older is in neo.snapshot and neo.conversation.read.',
  ].join('\n');
}

export const restartNeo = (superpipe({})('neo.restart') as PipelineAPI)
  .input(['deps'])
  .pipe((deps: NeoRestartDeps) => deps.open(), 'deps', 'sessionId')
  .pipe(
    (deps: NeoRestartDeps, sessionId: string) => deps.clear(sessionId),
    ['deps', 'sessionId'],
    'cleared'
  )
  .pipe(
    async (deps: NeoRestartDeps, sessionId: string) =>
      deps.note(sessionId, neoStateNote(await deps.entries())),
    ['deps', 'sessionId'],
    'noted'
  )
  .pipe((sessionId: string) => ({ ok: true as const, sessionId }), 'sessionId', 'result')
  .endAsync('result') as (deps: NeoRestartDeps) => Promise<{ ok: true; sessionId: string }>;
