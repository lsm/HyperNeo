import type { Database } from '../../storage/database.ts';
import type { NeoTurnReply } from './direct-reply-fallback.ts';

type Row = { kind: string; message: string };

function replyText(message: string): string {
  const parsed = JSON.parse(message) as { message?: { content?: unknown } };
  const content = parsed.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block: { type?: unknown; text?: unknown }) =>
      block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    )
    .join('\n\n');
}

export function readNeoTurnReply(db: Database, sessionId: string, messageId: string): NeoTurnReply {
  const rows = db
    .getDatabase()
    .prepare(
      `SELECT message_type AS kind, sdk_message AS message FROM sdk_messages
       WHERE session_id = ? AND message_type IN ('assistant', 'result')
         AND json_extract(sdk_message, '$.neoInputOrigin.messageId') = ?
       ORDER BY timestamp, rowid`
    )
    .all(sessionId, messageId) as Row[];
  const result = rows.findLast((row) => row.kind === 'result');
  const text =
    rows
      .filter((row) => row.kind === 'assistant')
      .map((row) => replyText(row.message))
      .filter((value) => value.trim())
      .at(-1) ?? null;
  if (!result) return { status: 'open', text };
  const subtype = (JSON.parse(result.message) as { subtype?: unknown }).subtype;
  return { status: subtype === 'success' ? 'ended' : 'failed', text };
}
