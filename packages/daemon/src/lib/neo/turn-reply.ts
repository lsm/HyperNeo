import type { Database } from '../../storage/database.ts';
import type { NeoTurnReply } from './direct-reply-fallback.ts';

type Row = { kind: string; message: string };

type Block = { type?: unknown; text?: unknown };

function replyBlocks(message: string): Block[] {
  const parsed = JSON.parse(message) as { message?: { content?: unknown } };
  const content = parsed.message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

function closingText(rows: Row[]): string | null {
  const closing: string[] = [];
  for (const row of rows) {
    if (row.kind !== 'assistant') continue;
    for (const block of replyBlocks(row.message)) {
      if (block?.type === 'tool_use') closing.length = 0;
      else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim())
        closing.push(block.text);
    }
  }
  return closing.length ? closing.join('\n\n') : null;
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
  const text = closingText(rows);
  if (!result) return { status: 'open', text };
  const subtype = (JSON.parse(result.message) as { subtype?: unknown }).subtype;
  return { status: subtype === 'success' ? 'ended' : 'failed', text };
}

export function neoAskStartedWork(db: Database, sessionId: string, messageId: string): boolean {
  return !!db
    .getDatabase()
    .prepare(
      `SELECT 1 FROM neo_consultations WHERE origin_session_id = ? AND origin_message_id = ?
       UNION ALL
       SELECT 1 FROM neo_consultation_waiters WHERE origin_session_id = ? AND origin_message_id = ?
       UNION ALL
       SELECT 1 FROM neo_work WHERE origin_session_id = ? AND origin_message_id = ?
       LIMIT 1`
    )
    .get(sessionId, messageId, sessionId, messageId, sessionId, messageId);
}
