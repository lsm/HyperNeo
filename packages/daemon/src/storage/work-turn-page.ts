import { z } from 'zod';
import { HandoffReference } from '../lib/handoffs/outbox.ts';
import { hydrateSdkMessageBodies } from './repositories/sdk-message-body-read.ts';
import { extractTextBlockContents } from './repositories/sdk-message-projections.ts';
import type { Database } from './sqlite-compat.ts';
import { readWorkTurns, type WorkTurn } from './work-turns.ts';

export const WorkReadCursor = z.object({
  sessionId: z.string().min(1),
  before: z.number().int().positive().safe(),
  resume: z
    .object({
      seq: z.number().int().positive().safe(),
      offset: z.number().int().nonnegative().safe(),
      through: z.number().int().positive().safe(),
    })
    .optional(),
});
type Cursor = z.infer<typeof WorkReadCursor>;
type Turn = WorkTurn & {
  textOffset?: number;
  textComplete?: boolean;
  files?: z.infer<typeof HandoffReference>[];
};
export interface WorkTurnPage {
  turns: Turn[];
  availability: 'complete' | 'incomplete' | 'reply_unavailable';
  nextCursor?: Cursor;
}
interface Row {
  body_seq: number;
  id: string;
  message_type: string;
  timestamp: string;
  sdk_message: string;
}
const SCOPE = `session_id=? AND parent_tool_use_id IS NULL AND COALESCE(internal_compaction_turn,0)=0
  AND message_type IN ('user','assistant','result') AND (message_type!='user' OR COALESCE(send_status,'consumed') IN ('consumed','failed'))
  AND NOT EXISTS (SELECT 1 FROM sdk_message_replacements r WHERE r.session_id=sdk_messages.session_id
    AND r.target_uuid=COALESCE(sdk_messages.sdk_uuid,sdk_messages.id) AND r.source_message_id!=sdk_messages.id)`;

function text(row: Row): string {
  const body = JSON.parse(row.sdk_message) as Record<string, unknown>;
  return row.message_type === 'result'
    ? typeof body.result === 'string'
      ? body.result
      : ''
    : extractTextBlockContents(body, 'join-all').join('\n\n');
}

function files(row: Row): Turn['files'] {
  return extractTextBlockContents(JSON.parse(row.sdk_message), 'join-all').flatMap((part) => {
    try {
      return z.object({ handoffFiles: z.array(HandoffReference) }).parse(JSON.parse(part))
        .handoffFiles;
    } catch {
      return [];
    }
  });
}

export function readWorkTurnPage(
  db: Database,
  sessionId: string,
  around: string | undefined,
  before: number,
  after: number,
  cursor?: Cursor
): WorkTurnPage | WorkTurn[] | null {
  if (!db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId))
    return readWorkTurns(db, sessionId, around, before, after);
  const select = (
    condition: string,
    args: (number | string)[],
    limit: number,
    descending = false
  ): Row[] =>
    db
      .prepare(
        hydrateSdkMessageBodies(
          `SELECT seq AS body_seq,id,message_type,timestamp FROM sdk_messages INDEXED BY idx_sdk_messages_parent_tool_use_id
      WHERE ${SCOPE} AND ${condition} ORDER BY seq ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
          `body_selection.body_seq ${descending ? 'DESC' : 'ASC'}`
        )
      )
      .all(sessionId, ...args, limit) as Row[];
  const unavailable: WorkTurnPage = { turns: [], availability: 'reply_unavailable' };
  const size = before + after + 1;
  let rows: Row[];
  if (cursor?.resume)
    rows = select('seq>=? AND seq<=?', [cursor.resume.seq, cursor.resume.through], size);
  else if (cursor) rows = select('seq<?', [cursor.before], size, true).reverse();
  else if (around) {
    const anchor = (db
      .prepare('SELECT seq FROM sdk_messages WHERE session_id=? AND id=?')
      .get(sessionId, around) ??
      db
        .prepare(
          'SELECT seq FROM sdk_messages WHERE session_id=? AND sdk_uuid=? ORDER BY seq LIMIT 1'
        )
        .get(sessionId, around)) as { seq: number } | undefined;
    if (!anchor || !select('seq=?', [anchor.seq], 1).length) return unavailable;
    rows = [
      ...select('seq<?', [anchor.seq], before, true).reverse(),
      ...select('seq>=?', [anchor.seq], after + 1),
    ];
  } else rows = select('1', [], size, true).reverse();
  if (!rows.length) return unavailable;
  const through = cursor?.resume?.through ?? rows.at(-1)!.body_seq;
  let boundary = cursor?.resume ? cursor.before : rows[0].body_seq;
  const turns: Turn[] = [];
  const seen = new Set<string>();
  let remaining = 16_000;
  for (let row of rows) {
    let value = text(row);
    if (row.message_type === 'result') {
      let prior = row.body_seq;
      let searching = true;
      while (searching) {
        const previous = select("seq<? AND message_type!='result'", [prior], 16, true);
        if (!previous.length) break;
        for (const candidate of previous) {
          prior = candidate.body_seq;
          const candidateText = text(candidate);
          if (!candidateText.trim()) continue;
          searching = false;
          if (
            candidate.message_type === 'assistant' &&
            (!value.trim() || candidateText.trim() === value.trim())
          ) {
            row = candidate;
            value = candidateText;
          }
          break;
        }
      }
    }
    if (!value.trim() || seen.has(row.id) || (cursor?.resume && row.body_seq < cursor.resume.seq))
      continue;
    seen.add(row.id);
    boundary = Math.min(boundary, row.body_seq);
    const start = cursor?.resume?.seq === row.body_seq ? cursor.resume.offset : 0;
    let end = Math.min(value.length, start + remaining);
    let low = start;
    while (low < end) {
      const mid = Math.ceil((low + end) / 2);
      if (Buffer.byteLength(JSON.stringify(value.slice(start, mid))) <= remaining) low = mid;
      else end = mid - 1;
    }
    end = low;
    if (end < value.length && end > start && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    if (end > start)
      turns.push({
        messageId: row.id,
        role: row.message_type === 'result' ? 'assistant' : row.message_type,
        at: new Date(row.timestamp).getTime(),
        text: value.slice(start, end),
        textOffset: start,
        textComplete: end === value.length,
        files: files(row),
      });
    remaining -= Buffer.byteLength(JSON.stringify(value.slice(start, end)));
    if (end < value.length)
      return {
        turns,
        availability: 'incomplete',
        nextCursor: {
          sessionId,
          before: boundary,
          resume: { seq: row.body_seq, offset: end, through },
        },
      };
  }
  if (cursor?.resume && rows.at(-1)!.body_seq < through) {
    const next = select('seq>? AND seq<=?', [rows.at(-1)!.body_seq, through], 1)[0];
    if (next)
      return {
        turns,
        availability: 'incomplete',
        nextCursor: {
          sessionId,
          before: boundary,
          resume: { seq: next.body_seq, offset: 0, through },
        },
      };
  }
  const earlier = select('seq<?', [boundary], 1, true).length > 0;
  return {
    turns,
    availability: earlier ? 'incomplete' : turns.length ? 'complete' : 'reply_unavailable',
    ...(earlier ? { nextCursor: { sessionId, before: boundary } } : {}),
  };
}
