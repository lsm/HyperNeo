import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { resolveNeoCardReply } from './public-conversation.ts';

export type NeoWorkFocus = { askId: string; questionId?: string; todoId?: string };
export type NeoWorkSelector = { askId?: string; questionId?: string; todoId?: string };
type Reference = { kind: 'ask' | 'question' | 'todo'; id: string };

export const resolveNeoWorkReference = (superpipe({})('neo.work.reference') as PipelineAPI)
  .input(['anchor', 'entries', 'read'])
  .pipe(
    (anchor: string) => {
      const match = /^neo-ref-(ask|question|todo)-(.+)$/.exec(anchor);
      return match ? { value: { kind: match[1], id: match[2] } } : { reason: 'unavailable' };
    },
    'anchor',
    'result:reference'
  )
  .pipe(
    async (
      reference: Reference,
      entries: readonly NeoAskEntry[],
      read: (input: NeoWorkSelector) => Promise<NeoAskEntry>
    ) =>
      entries.find((entry) =>
        reference.kind === 'ask'
          ? entry.ask.id === reference.id
          : reference.kind === 'todo'
            ? entry.todos.some((todo) => todo.id === reference.id)
            : [...entry.questions, ...(entry.summary?.questionRefs ?? [])].some(
                (question) => question.id === reference.id
              )
      ) ?? (await read({ [`${reference.kind}Id`]: reference.id })),
    ['reference', 'entries', 'read'],
    'owner'
  )
  .pipe(
    (reference: Reference, entry: NeoAskEntry) => {
      const target =
        reference.kind === 'question'
          ? resolveNeoCardReply({ askId: entry.ask.id, questionId: reference.id }, [entry])
          : { askId: entry.ask.id, ...(reference.kind === 'todo' ? { todoId: reference.id } : {}) };
      return target === 'unavailable' ? { reason: target } : { value: { entry, target } };
    },
    ['reference', 'owner'],
    'result:reference'
  )
  .endAsync('reference') as (
  anchor: string,
  entries: readonly NeoAskEntry[],
  read: (input: NeoWorkSelector) => Promise<NeoAskEntry>
) => Promise<{ entry: NeoAskEntry; target: NeoWorkFocus } | 'unavailable'>;

export function neoWorkReferenceEntry(entry: NeoAskEntry): NeoAskEntry {
  return {
    ...entry,
    todos: entry.todos.filter((todo) => todo.state !== 'done'),
    summary: entry.summary ?? {
      todoCount: entry.todos.length,
      questionCount: entry.questions.length,
      openQuestionCount: entry.questions.filter((question) => question.state === 'open').length,
      questionRefs: entry.questions.map(({ id, replacedBy }) => ({ id, replacedBy })),
    },
  };
}
