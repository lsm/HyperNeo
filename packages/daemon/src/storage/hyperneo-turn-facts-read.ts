import { CONSUMED_INPUT, SESSION_BILLING_TERMINAL } from '../lib/drivers/space-input-evidence.ts';
import type { WorkTurnFact } from '../lib/drivers/types.ts';
import { sdkMessageBodyAt } from './repositories/sdk-message-body-read.ts';
import type { Database as BunDatabase } from './sqlite-compat.ts';

const TURNS_PER_READ = 10;
const URL_PATTERN = /https?:\/\/[^\s"'<>\\)\]`]+/g;

type Position = { seq: number; consumed: number; at: number | null };
type Terminal = {
  seq: number;
  id: string;
  timestamp: string;
  consumed: number | null;
  ended: string | null;
};
type Input = { id: string; timestamp: string };

export const readTurnUrls = (bodies: readonly string[]) => [
  ...new Set(
    bodies
      .flatMap((body) => body.match(URL_PATTERN) ?? [])
      .map((url) => url.replace(/[.,;:*]+$/, ''))
  ),
];

function planTurnFact(
  from: Position,
  terminal: Terminal,
  inputs: readonly Input[],
  bodies: readonly (string | null)[]
): WorkTurnFact {
  const endedAt = Date.parse(terminal.timestamp);
  const firstInput = inputs[0] ? Date.parse(inputs[0].timestamp) : null;
  const position: Position = {
    seq: terminal.seq,
    consumed: terminal.consumed ?? from.consumed,
    at: endedAt,
  };
  return {
    id: terminal.id,
    startedAt: Math.max(from.at ?? 0, firstInput ?? 0) || endedAt,
    endedAt,
    ended: terminal.ended ?? 'unknown',
    inputs: inputs.map((input) => input.id),
    urls: readTurnUrls(bodies.flatMap((body) => body ?? [])),
    finalUrls: readTurnUrls([bodies.at(-1) ?? '']),
    complete: bodies.every((body) => !!body),
    cursor: JSON.stringify(position),
  };
}

export function readHyperneoTurnFacts(
  db: BunDatabase,
  sessionId: string,
  cursor?: string,
  limit = TURNS_PER_READ
): WorkTurnFact[] {
  let from: Position = cursor ? JSON.parse(cursor) : { seq: 0, consumed: 0, at: null };
  const terminals = db
    .prepare(`SELECT seq, id, timestamp, consumed_seq AS consumed, message_subtype AS ended
      FROM sdk_messages WHERE session_id = ? AND ${SESSION_BILLING_TERMINAL} AND seq > ?
      ORDER BY seq LIMIT ?`)
    .all(sessionId, from.seq, limit) as Terminal[];
  const inputs = db.prepare(`SELECT sdk_uuid AS id, timestamp FROM sdk_messages
    WHERE session_id = ? AND ${CONSUMED_INPUT} AND COALESCE(input_kind, '') <> 'system'
      AND consumed_seq > ? AND consumed_seq <= ?
    ORDER BY consumed_seq`);
  const outputs = db.prepare(`SELECT ${sdkMessageBodyAt('sdk_messages.rowid')} AS body
    FROM sdk_messages WHERE session_id = ? AND seq > ? AND seq <= ? AND (seq = ?
      OR (message_type = 'user' AND first_block_type = 'tool_result')) ORDER BY seq`);
  return terminals.map((terminal) => {
    const consumed = terminal.consumed ?? from.consumed;
    const fact = planTurnFact(
      from,
      terminal,
      inputs.all(sessionId, from.consumed, consumed) as Input[],
      (
        outputs.all(sessionId, from.seq, terminal.seq, terminal.seq) as { body: string | null }[]
      ).map((row) => row.body)
    );
    from = JSON.parse(fact.cursor);
    return fact;
  });
}
