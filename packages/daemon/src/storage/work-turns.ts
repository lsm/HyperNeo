import type { Database as BunDatabase } from './sqlite-compat.ts';

const TURN_TEXT_CHARS = 4_000;

export interface WorkTurn {
  messageId: string;
  role: string;
  at: number;
  text: string;
}

interface WorkTurnRow {
  id: number;
  messageId: string;
  role: string | null;
  at: number | string | null;
  text: string | null;
}

const TURN_COLUMNS = `id, COALESCE(message_id, source_id) AS messageId, message_type AS role,
  timestamp AS at, body AS text`;

function toTurn(row: WorkTurnRow): WorkTurn {
  const text = row.text ?? '';
  const at = Number(row.at);
  return {
    messageId: row.messageId,
    role: row.role ?? 'message',
    at: Number.isFinite(at) ? at : 0,
    text: text.length > TURN_TEXT_CHARS ? `${text.slice(0, TURN_TEXT_CHARS)}…` : text,
  };
}

const TURN_SCOPES = [
  `kind = 'message' AND session_id = ?`,
  `kind IN ('codex', 'claude') AND session_id = ?`,
];

export function readWorkTurns(
  db: BunDatabase,
  sessionId: string,
  around: string | undefined,
  before: number,
  after: number
): WorkTurn[] | null {
  for (const scope of TURN_SCOPES) {
    const turns = readScopedTurns(db, scope, sessionId, around, before, after);
    if (turns) return turns;
  }
  return null;
}

function readScopedTurns(
  db: BunDatabase,
  scope: string,
  sessionId: string,
  around: string | undefined,
  before: number,
  after: number
): WorkTurn[] | null {
  if (!around) {
    const rows = db
      .prepare(
        `SELECT ${TURN_COLUMNS} FROM message_search_content WHERE ${scope}
          ORDER BY timestamp DESC, id DESC LIMIT ?`
      )
      .all(sessionId, before + after + 1) as WorkTurnRow[];
    return rows.length === 0 ? null : rows.reverse().map(toTurn);
  }
  const anchor = db
    .prepare(
      `SELECT id, timestamp AS at FROM message_search_content
        WHERE ${scope} AND (message_id = ? OR source_id = ?) LIMIT 1`
    )
    .get(sessionId, around, around) as { id: number; at: number | null } | undefined;
  if (!anchor) return null;
  const earlier = db
    .prepare(
      `SELECT ${TURN_COLUMNS} FROM message_search_content
        WHERE ${scope} AND (timestamp, id) < (?, ?) ORDER BY timestamp DESC, id DESC LIMIT ?`
    )
    .all(sessionId, anchor.at, anchor.id, before) as WorkTurnRow[];
  const later = db
    .prepare(
      `SELECT ${TURN_COLUMNS} FROM message_search_content
        WHERE ${scope} AND (timestamp, id) >= (?, ?) ORDER BY timestamp, id LIMIT ?`
    )
    .all(sessionId, anchor.at, anchor.id, after + 1) as WorkTurnRow[];
  return [...earlier.reverse(), ...later].map(toTurn);
}
