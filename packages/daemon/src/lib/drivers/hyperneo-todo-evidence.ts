import type { Database } from '../../storage/sqlite-compat.ts';
import { readWorkTurnPage } from '../../storage/work-turn-page.ts';
import { readSessionInputEvidence, SESSION_BILLING_TERMINAL } from './space-input-evidence.ts';
import type { WorkDelivery, WorkDetail } from './types.ts';

type Receipt = NonNullable<WorkDelivery['receipt']>;
type Evidence = NonNullable<WorkDetail['inputEvidence']>;

export async function readHyperneoTodoEvidence(
  db: Database,
  sessionId: string,
  receipt: Receipt
): Promise<Evidence> {
  const evidence = readSessionInputEvidence(db, sessionId, receipt);
  if (evidence.state === 'pending') return evidence;
  const unavailable: Evidence = {
    receipt,
    state: 'unavailable',
    replyAvailability: 'reply_unavailable',
  };
  if (evidence.state !== 'observed') return unavailable;
  const input = db
    .prepare(`SELECT seq,consumed_seq FROM sdk_messages
    WHERE session_id=? AND sdk_uuid=? AND message_type='user'`)
    .get(sessionId, receipt.inputId) as { seq: number; consumed_seq: number };
  const terminal = db
    .prepare(`SELECT seq,id,consumed_seq,timestamp FROM sdk_messages
    WHERE session_id=? AND ${SESSION_BILLING_TERMINAL} AND consumed_seq>=? ORDER BY consumed_seq,seq LIMIT 1`)
    .get(sessionId, input.consumed_seq) as
    | { seq: number; id: string; consumed_seq: number; timestamp: string }
    | undefined;
  if (!terminal) return { ...evidence, replyAvailability: 'incomplete' };
  const prior = db
    .prepare(`SELECT seq FROM sdk_messages WHERE session_id=? AND ${SESSION_BILLING_TERMINAL}
    AND consumed_seq<? ORDER BY consumed_seq DESC,seq DESC LIMIT 1`)
    .get(sessionId, terminal.consumed_seq) as { seq: number } | undefined;
  const parts = new Map<string, { seq: number; chunks: string[] }>();
  let cursor: Parameters<typeof readWorkTurnPage>[5];
  do {
    const page = readWorkTurnPage(db, sessionId, terminal.id, 10, 0, cursor, {
      afterSeq: Math.max(prior?.seq ?? 0, input.seq),
      throughSeq: terminal.seq,
    });
    if (!page || Array.isArray(page) || page.availability === 'reply_unavailable')
      return unavailable;
    for (const turn of page.turns) {
      if (turn.role !== 'assistant') continue;
      let part = parts.get(turn.messageId);
      if (!part) {
        const row = db
          .prepare('SELECT seq FROM sdk_messages WHERE session_id=? AND id=?')
          .get(sessionId, turn.messageId) as { seq: number };
        part = { seq: row.seq, chunks: [] };
        parts.set(turn.messageId, part);
      }
      part.chunks.push(turn.text);
    }
    cursor = page.nextCursor;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  } while (cursor);
  const report = [...parts.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((part) => `Agent: ${part.chunks.join('')}`)
    .join('\n\n');
  return {
    ...evidence,
    replyAvailability: 'complete',
    replyAt: Date.parse(terminal.timestamp),
    replyReport: report || 'The completed turn has no visible assistant text.',
  };
}
