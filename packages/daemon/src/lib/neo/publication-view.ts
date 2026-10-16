import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import {
  type NeoPublicationAnchor,
  NeoPublicationAnchorRepository,
} from '../../storage/repositories/neo-publication-anchor-repository.ts';
import { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';

export const NEO_PUBLICATION_VIEW_RECENT = 6;
const NEO_PUBLICATION_VIEW_MAX = 20;

type Mark = { fresh: boolean; compaction: number };

export function isNeoPublicationViewReset(
  anchor: NeoPublicationAnchor | null,
  mark: Mark
): boolean {
  return !anchor || mark.fresh || anchor.compaction !== mark.compaction;
}

export function nextNeoPublicationAnchor(
  anchor: NeoPublicationAnchor | null,
  seen: readonly NeoPublication[],
  mark: Mark
): NeoPublicationAnchor {
  return { sequence: seen.at(-1)?.sequence ?? anchor?.sequence ?? 0, compaction: mark.compaction };
}

export function neoPublicationViewNote(
  seen: readonly NeoPublication[],
  reset: boolean
): string | null {
  const items = seen.filter((item) => !item.interim);
  if (!items.length) return null;
  const lines = items.map(
    (item) =>
      `- ${item.createdAt}${item.askSummary ? `, on "${item.askSummary}"` : ''}${item.corrects ? ' (correction)' : ''}: ${item.shortText}`
  );
  return [
    reset
      ? 'What the human has already read from Neo in this conversation, oldest first:'
      : 'What the human has read from Neo since your last turn, oldest first:',
    ...lines,
    'The human already has these.',
  ].join('\n');
}

export const readNeoPublicationView = (superpipe({})('neo-publication-view') as PipelineAPI)
  .input(['db', 'sessionId', 'fresh'])
  .pipe(
    (db: Database) => new NeoRepository(db.getDatabase()).getBindingForProject(null)?.sessionId,
    'db',
    'root'
  )
  .pipe(
    (root: string | undefined) =>
      root?.startsWith('neo:') ? { value: root.slice(4) } : { reason: null },
    'root',
    'result:conversation'
  )
  .pipe(
    (db: Database, sessionId: string) =>
      new NeoPublicationAnchorRepository(db.getDatabase()).get(sessionId),
    ['db', 'sessionId'],
    'anchor'
  )
  .pipe(
    (db: Database, sessionId: string, fresh: boolean): Mark => ({
      fresh,
      compaction: db.getSDKMessageRepo().latestCompactionSeq(sessionId),
    }),
    ['db', 'sessionId', 'fresh'],
    'mark'
  )
  .pipe(isNeoPublicationViewReset, ['anchor', 'mark'], 'reset')
  .pipe(
    (db: Database, conversation: string, anchor: NeoPublicationAnchor | null, reset: boolean) => {
      const publications = new NeoPublicationRepository(db.getDatabase());
      return reset
        ? publications.listRecent(conversation, NEO_PUBLICATION_VIEW_RECENT).reverse()
        : (publications.list(conversation, anchor!.sequence, NEO_PUBLICATION_VIEW_MAX) ?? []);
    },
    ['db', 'conversation', 'anchor', 'reset'],
    'seen'
  )
  .pipe(
    (
      db: Database,
      sessionId: string,
      anchor: NeoPublicationAnchor | null,
      seen: NeoPublication[],
      mark: Mark
    ) =>
      new NeoPublicationAnchorRepository(db.getDatabase()).save(
        sessionId,
        nextNeoPublicationAnchor(anchor, seen, mark)
      ),
    ['db', 'sessionId', 'anchor', 'seen', 'mark'],
    'saved'
  )
  .pipe(neoPublicationViewNote, ['seen', 'reset'], 'note')
  .pipe((note: string | null, reset: boolean) => ({ note, reset }), ['note', 'reset'], 'view')
  .end('view') as (
  db: Database,
  sessionId: string,
  fresh: boolean
) => { note: string | null; reset: boolean };

export function withNeoPublicationView<T extends { message?: { content?: unknown } }>(
  input: T,
  note: string | null
): T {
  const content = input.message?.content;
  if (!note || !input.message || (typeof content !== 'string' && !Array.isArray(content)))
    return input;
  return {
    ...input,
    message: {
      ...input.message,
      content:
        typeof content === 'string'
          ? `${content}\n\n${note}`
          : [...content, { type: 'text', text: note }],
    },
  };
}
