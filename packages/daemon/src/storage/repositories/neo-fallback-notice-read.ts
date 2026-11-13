import { FRONT_FALLBACK_TEXT, frontFallbackId } from '../../lib/neo/front-catch-up.ts';
import type { Database } from '../sqlite-compat.ts';

export function hasFallbackFor(db: Database, conversationId: string, messageId: string): boolean {
  const rows = db
    .prepare(
      `SELECT p.publication_id AS id, p.payload_json AS payload FROM neo_publications p,
        json_each(p.payload_json, '$.replyTo') ref
      WHERE p.conversation_id = ? AND ref.value = ?
        AND json_extract(p.payload_json, '$.fullText') = ?`
    )
    .all(conversationId, messageId, FRONT_FALLBACK_TEXT) as { id: string; payload: string }[];
  return rows.some((row) => {
    const { publicationId, replyTo } = JSON.parse(row.payload) as {
      publicationId: string;
      replyTo?: string[];
    };
    return (
      row.id === publicationId && publicationId === frontFallbackId(conversationId, replyTo ?? [])
    );
  });
}
