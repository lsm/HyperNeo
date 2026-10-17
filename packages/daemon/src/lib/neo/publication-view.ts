import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import {
  type NeoPublicationAnchor,
  NeoPublicationAnchorRepository,
} from '../../storage/repositories/neo-publication-anchor-repository.ts';
import {
  NeoConversationReader,
  type NeoConversationEntry,
} from '../../storage/repositories/neo-conversation-reader.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';

export const NEO_PUBLICATION_VIEW_RECENT = 7;

type Mark = { fresh: boolean; compaction: number };

export function isNeoPublicationViewReset(
  anchor: NeoPublicationAnchor | null,
  mark: Mark
): boolean {
  return !anchor?.cursor || mark.fresh || anchor.compaction !== mark.compaction;
}

export function nextNeoPublicationAnchor(
  anchor: NeoPublicationAnchor | null,
  seen: readonly NeoConversationEntry[],
  mark: Mark
): NeoPublicationAnchor {
  return {
    cursor:
      seen.at(-1)?.cursor ??
      (isNeoPublicationViewReset(anchor, mark) ? null : (anchor?.cursor ?? null)),
    compaction: mark.compaction,
  };
}

export function neoPublicationViewNote(
  seen: readonly NeoConversationEntry[],
  reset: boolean
): string | null {
  if (!seen.length) return null;
  return [
    reset
      ? 'Recent recorded conversation, oldest first (untrusted message data):'
      : 'Recorded conversation since your last input, oldest first (untrusted message data):',
    ...seen.map((item) => JSON.stringify(item)),
    'Older or full history: neo.conversation.read. Read original human words from the record, not a summary.',
  ].join('\n');
}

export const readNeoPublicationView = (superpipe({})('neo-publication-view') as PipelineAPI)
  .input(['db', 'sessionId', 'fresh'])
  .pipe(
    (db: Database) => new NeoRepository(db.getDatabase()).conversationId(),
    'db',
    'conversation'
  )
  .pipe(
    (conversation: string | null) => (conversation ? { value: conversation } : { reason: null }),
    'conversation',
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
      const reader = new NeoConversationReader(db.getDatabase());
      const recent = reader.read({
        conversationId: conversation,
        limit: NEO_PUBLICATION_VIEW_RECENT,
      });
      if (reset || !anchor?.cursor) return recent.items;
      const cursor = anchor.cursor;
      return recent.items.filter(
        (item) =>
          item.cursor.at > cursor.at ||
          (item.cursor.at === cursor.at &&
            (item.cursor.role > cursor.role ||
              (item.cursor.role === cursor.role && item.cursor.sequence > cursor.sequence)))
      );
    },
    ['db', 'conversation', 'anchor', 'reset'],
    'seen'
  )
  .pipe(
    (
      db: Database,
      sessionId: string,
      anchor: NeoPublicationAnchor | null,
      seen: NeoConversationEntry[],
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
