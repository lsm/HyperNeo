import type { NeoConversationAskPageItem } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import type { NeoSessionMessage } from '@hyperneo/shared/types/neo-session-message';
import type { NeoConversationWake } from '@hyperneo/shared/types/neo-wake';
import {
  NEO_WAKE_SELECT,
  NeoConversationWakeRepository,
} from './neo-conversation-wake-repository.ts';
import { z } from 'zod';
import type { Database } from '../sqlite-compat.ts';
import { NeoConversationAskRepository } from './neo-conversation-ask-repository.ts';
import { NeoPublicationRepository } from './neo-publication-repository.ts';
import { NeoSessionMessageRepository, SENT_BY_NEO } from './neo-session-message-repository.ts';
import { presentNeoAskImageRefs } from '../../lib/neo/conversation-ask-read-operation.ts';
import type { NeoMessageStatusPresenter } from '../../lib/neo/message-status.ts';

export const NeoConversationCursorSchema = z
  .object({
    at: z.iso.datetime(),
    role: z.enum(['human', 'neo', 'session', 'wake']),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type NeoConversationCursor = z.infer<typeof NeoConversationCursorSchema>;
export const NeoConversationReadInput = z
  .object({
    conversationId: z.uuid(),
    after: NeoConversationCursorSchema.optional(),
    before: NeoConversationCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((input) => !input.after || !input.before);
export type NeoConversationPage = z.infer<typeof NeoConversationReadInput>;
export type NeoConversationEntry =
  | { cursor: NeoConversationCursor; role: 'human'; ask: NeoConversationAskPageItem }
  | { cursor: NeoConversationCursor; role: 'neo'; publication: NeoPublication }
  | { cursor: NeoConversationCursor; role: 'session'; message: NeoSessionMessage }
  | { cursor: NeoConversationCursor; role: 'wake'; wake: NeoConversationWake };
type Row = NeoConversationCursor & { id: string };

export function neoConversationPage(entries: NeoConversationEntry[], page: NeoConversationPage) {
  return {
    items: entries,
    nextAfter: entries.at(-1)?.cursor ?? page.after ?? null,
    nextBefore: entries.at(0)?.cursor ?? page.before ?? null,
  };
}

export class NeoConversationReader {
  constructor(
    private readonly db: Database,
    private readonly presentStatus: NeoMessageStatusPresenter = (items) => [...items]
  ) {}

  read(page: NeoConversationPage, humanView = false) {
    const cursor = page.after ?? page.before;
    const direction = page.after ? 'ASC' : 'DESC';
    const rows = this.db
      .prepare(`SELECT * FROM (
      SELECT created_at AS at, 'human' AS role, sequence, request_id AS id
        FROM neo_conversation_asks WHERE conversation_id = ?
      UNION ALL
      SELECT created_at AS at, 'neo' AS role, sequence, publication_id AS id
        FROM neo_publications WHERE conversation_id = ?
      UNION ALL
      SELECT created_at AS at, 'session' AS role, sequence, message_id AS id
        FROM neo_session_messages WHERE conversation_id = ?${humanView ? ` AND ${SENT_BY_NEO}` : ''}
      UNION ALL ${NEO_WAKE_SELECT})
      ${cursor ? `WHERE (at, role, sequence) ${page.after ? '>' : '<'} (?, ?, ?)` : ''}
      ORDER BY at ${direction}, role ${direction}, sequence ${direction} LIMIT ?`)
      .all(
        page.conversationId,
        page.conversationId,
        page.conversationId,
        page.conversationId,
        ...(cursor ? [cursor.at, cursor.role, cursor.sequence] : []),
        page.limit
      ) as Row[];
    if (!page.after) rows.reverse();
    const asks = new NeoConversationAskRepository(this.db);
    const publications = new NeoPublicationRepository(this.db);
    const sessionMessages = new NeoSessionMessageRepository(this.db);
    const items = rows.map((row): NeoConversationEntry => {
      const cursor = { at: row.at, role: row.role, sequence: row.sequence };
      if (row.role === 'wake') {
        const wake = new NeoConversationWakeRepository(this.db).get(page.conversationId, row.id);
        if (!wake) throw new Error('Recorded wake disappeared');
        return { cursor, role: row.role, wake };
      }
      if (row.role === 'human') {
        const ask = asks.find(page.conversationId, row.id);
        if (!ask) throw new Error('Recorded human message disappeared');
        return {
          cursor,
          role: row.role,
          ask: presentNeoAskImageRefs([ask], asks.images(page.conversationId, [ask.requestId]))[0],
        };
      }
      if (row.role === 'session') {
        const message = sessionMessages.get(page.conversationId, row.id);
        if (!message) throw new Error('Recorded session message disappeared');
        return { cursor, role: row.role, message };
      }
      const publication = publications.get(page.conversationId, row.id);
      if (!publication) throw new Error('Recorded Neo message disappeared');
      return { cursor, role: row.role, publication };
    });
    const statuses = new Map(
      this.presentStatus(items.flatMap((item) => (item.role === 'human' ? [item.ask] : []))).map(
        (ask) => [ask.requestId, ask]
      )
    );
    return neoConversationPage(
      items.map((item) =>
        item.role === 'human' ? { ...item, ask: statuses.get(item.ask.requestId)! } : item
      ),
      page
    );
  }
}
