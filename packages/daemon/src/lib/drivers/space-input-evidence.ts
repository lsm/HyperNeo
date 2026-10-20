import { sdkMessageBodyAt } from '../../storage/repositories/sdk-message-body-read.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import type { WorkDelivery, WorkDetail, WorkRef } from './types.ts';
import { hyperneoInputText } from './hyperneo-adapter.ts';
import { exchangeEntry, workEntryTime } from './work-messages.ts';

type Receipt = NonNullable<WorkDelivery['receipt']>;
type Evidence = NonNullable<WorkDetail['inputEvidence']>;
type InputRow = {
  message: string;
  timestamp: string;
  sendStatus: string | null;
  seq: number | null;
};
type ReplyRow = { message: string; timestamp: string };

export const SESSION_BILLING_TERMINAL = `message_type='result' AND is_terminal=1 AND parent_tool_use_id IS NULL
  AND COALESCE(internal_compaction_turn,0)=0
  AND NOT (COALESCE(recovery_intercepted,0)=1 AND COALESCE(recovery_billing_terminal,0)=0)`;

const CONSUMED_INPUT = `message_type = 'user' AND parent_tool_use_id IS NULL
  AND COALESCE(send_status, 'consumed') = 'consumed'
  AND COALESCE(is_replay, 0) = 0
  AND COALESCE(internal_compaction_turn, 0) = 0
  AND COALESCE(first_block_type, 'text') <> 'tool_result'`;

function readInput(db: Database, taskId: string | null, receipt: Receipt) {
  const rows = db
    .prepare(`SELECT ${sdkMessageBodyAt('sdk_messages.rowid')} AS message, timestamp, send_status AS sendStatus,
    consumed_seq AS seq FROM sdk_messages
    WHERE session_id = ? AND sdk_uuid = ? AND task_id IS ? AND message_type = 'user'
      AND parent_tool_use_id IS NULL LIMIT 2`)
    .all(receipt.executionId, receipt.inputId, taskId) as InputRow[];
  return { rows };
}

function requireInput(
  source: { rows: InputRow[] },
  receipt: Receipt
): { value: InputRow } | { reason: Evidence } {
  const unavailable: Evidence = { receipt, state: 'unavailable' };
  if (source.rows.length !== 1) return { reason: unavailable };
  const row = source.rows[0];
  try {
    const payload = JSON.parse(row.message);
    if (
      payload.type !== 'user' ||
      payload.isReplay ||
      payload.internal_compaction_turn ||
      payload.message?.content?.[0]?.type === 'tool_result' ||
      workEntryTime(row.timestamp) === undefined
    )
      return { reason: unavailable };
  } catch {
    return { reason: unavailable };
  }
  if (['enqueued', 'deferred', 'submitted'].includes(row.sendStatus ?? ''))
    return { reason: { receipt, state: 'pending' } };
  if ((row.sendStatus !== null && row.sendStatus !== 'consumed') || row.seq === null)
    return { reason: unavailable };
  return { value: row };
}

function readReplies(db: Database, receipt: Receipt, input: InputRow) {
  const uncertain = db
    .prepare(`SELECT 1 FROM sdk_messages WHERE session_id = ?1
    AND ${CONSUMED_INPUT} AND consumed_seq IS NULL
    UNION ALL SELECT 1 FROM sdk_messages WHERE session_id = ?1
    AND ${CONSUMED_INPUT} AND consumed_seq = ?2 AND sdk_uuid IS NOT ?3
    AND NOT EXISTS (SELECT 1 FROM sdk_messages terminal WHERE session_id=?1
      AND ${SESSION_BILLING_TERMINAL} AND consumed_seq=?2) LIMIT 1`)
    .get(receipt.executionId, input.seq, receipt.inputId);
  if (uncertain) return { rows: null };
  const rows = db
    .prepare(`SELECT ${sdkMessageBodyAt('sdk_messages.rowid')} AS message, timestamp FROM sdk_messages
    WHERE session_id = ?1 AND message_type = 'result' AND is_terminal = 1
      AND parent_tool_use_id IS NULL AND consumed_seq >= ?2
      AND consumed_seq < COALESCE((SELECT MIN(consumed_seq) FROM sdk_messages
        WHERE session_id = ?1 AND ${CONSUMED_INPUT} AND consumed_seq > ?2), 9223372036854775807)
      AND COALESCE(internal_compaction_turn, 0) = 0
      AND NOT (COALESCE(recovery_intercepted, 0) = 1
        AND COALESCE(recovery_billing_terminal, 0) = 0)
    ORDER BY consumed_seq ASC, rowid ASC LIMIT 40`)
    .all(receipt.executionId, input.seq) as ReplyRow[];
  return { rows };
}

function projectEvidence(
  receipt: Receipt,
  input: InputRow,
  replies: { rows: ReplyRow[] | null }
): Evidence {
  const unavailable: Evidence = { receipt, state: 'unavailable' };
  if (!replies.rows) return unavailable;
  try {
    const first = exchangeEntry(
      workEntryTime(input.timestamp),
      'user',
      hyperneoInputText(input.message) || '[Non-text input]',
      -Infinity
    );
    if (!first) return unavailable;
    const exchange = [first];
    for (const row of replies.rows.slice(0, 39)) {
      const entry = exchangeEntry(
        workEntryTime(row.timestamp),
        'agent',
        JSON.parse(row.message).result || '[No written result]',
        -Infinity
      );
      if (!entry) return unavailable;
      exchange.push(entry);
    }
    return { receipt, state: 'observed', exchange, exchangeCut: replies.rows.length > 39 };
  } catch {
    return unavailable;
  }
}

const readInputEvidence = (superpipe({})('session-input-evidence') as PipelineAPI)
  .input(['db', 'taskId', 'receipt'])
  .pipe(readInput, ['db', 'taskId', 'receipt'], 'source')
  .pipe(requireInput, ['source', 'receipt'], 'result:evidence')
  .pipe(readReplies, ['db', 'receipt', 'evidence'], 'replies')
  .pipe(projectEvidence, ['receipt', 'evidence', 'replies'], 'evidence')
  .end('evidence') as (db: Database, taskId: string | null, receipt: Receipt) => Evidence;

export function readSpaceInputEvidence(db: Database, ref: WorkRef, receipt: Receipt): Evidence {
  return readInputEvidence(db, ref.id, receipt);
}

export function readSessionInputEvidence(
  db: Database,
  sessionId: string,
  receipt: Receipt
): Evidence {
  return receipt.executionId === sessionId
    ? readInputEvidence(db, null, receipt)
    : { receipt, state: 'unavailable' };
}
