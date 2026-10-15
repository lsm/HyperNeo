import type { Database } from '../sqlite-compat.ts';

const TEXT_CHARS = 10_000;

export type NeoRouteDestination = 'main' | 'holder';

export interface NeoRoute {
  id: number;
  messageId: string;
  conversationId: string;
  askedAt: number;
  ask: string;
  destination: NeoRouteDestination;
  targetSessionId: string | null;
  projectId: string | null;
  signal: string;
  confidence: number | null;
  outcome: string | null;
  outcomeAt: number | null;
  askSummary: string | null;
  awaiting: string | null;
  cause?: string | null;
}

export type NeoRouteEntry = Omit<
  NeoRoute,
  'id' | 'outcome' | 'outcomeAt' | 'askSummary' | 'awaiting'
>;

export interface NeoTurnNotes {
  askSummary?: string;
  awaiting?: string;
}

const columns = `id, message_id AS messageId, conversation_id AS conversationId,
  asked_at AS askedAt, ask, destination, target_session_id AS targetSessionId,
  concern_id AS projectId, signal, confidence, outcome, outcome_at AS outcomeAt,
  ask_summary AS askSummary, awaiting, cause`;

export function neoExcerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const head = Math.ceil((max - 1) / 2);
  return `${flat.slice(0, head)}…${flat.slice(flat.length - (max - 1 - head))}`;
}

function clip(text: string): string {
  return neoExcerpt(text, TEXT_CHARS);
}

export class NeoRoutingLogRepository {
  private present: boolean | null = null;

  constructor(private readonly db: Database) {}

  private ready(): boolean {
    this.present ??= !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_routing_log' AND type = 'table'")
      .get();
    return this.present;
  }

  record(entry: NeoRouteEntry): void {
    if (!this.ready()) return;
    this.db
      .prepare(
        `INSERT INTO neo_routing_log (message_id, conversation_id, asked_at, ask, destination,
           target_session_id, concern_id, signal, confidence, cause)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`
      )
      .run(
        entry.messageId,
        entry.conversationId,
        entry.askedAt,
        clip(entry.ask),
        entry.destination,
        entry.targetSessionId,
        entry.projectId,
        entry.signal,
        entry.confidence,
        entry.cause ? clip(entry.cause) : null
      );
  }

  latestFailure(): { at: number; signal: string; cause: string } | null {
    if (!this.ready()) return null;
    return (
      (this.db
        .prepare(
          `SELECT asked_at AS at, signal, cause FROM neo_routing_log
           WHERE cause IS NOT NULL ORDER BY id DESC LIMIT 1`
        )
        .get() as { at: number; signal: string; cause: string } | undefined) ?? null
    );
  }

  recordOutcome(
    messageId: string,
    outcome: string,
    at: number,
    notes: NeoTurnNotes = {},
    replace = false
  ): void {
    if (!this.ready()) return;
    const answered = this.db
      .prepare(
        `UPDATE neo_routing_log SET outcome = ?, outcome_at = ?, digested_at = NULL,
           ask_summary = ?, awaiting = ?
          WHERE message_id = ? AND (outcome IS NULL OR ?) RETURNING id, destination`
      )
      .get(
        clip(outcome),
        at,
        notes.askSummary ? clip(notes.askSummary) : null,
        notes.awaiting ? clip(notes.awaiting) : null,
        messageId,
        replace ? 1 : 0
      ) as { id: number; destination: string } | null;
    if (answered?.destination !== 'main') return;
    this.db
      .prepare(
        `UPDATE neo_routing_log SET digested_at = ?
          WHERE destination != 'main' AND digested_at IS NULL AND id < ?`
      )
      .run(at, answered.id);
  }

  undigested(limit: number): NeoRoute[] {
    if (!this.ready()) return [];
    return this.db
      .prepare(
        `SELECT ${columns} FROM neo_routing_log
          WHERE destination != 'main' AND digested_at IS NULL
          ORDER BY id DESC LIMIT ?`
      )
      .all(limit)
      .reverse() as NeoRoute[];
  }

  find(messageId: string): NeoRoute | null {
    if (!this.ready()) return null;
    return (
      (this.db
        .prepare(`SELECT ${columns} FROM neo_routing_log WHERE message_id = ?`)
        .get(messageId) as NeoRoute | null) ?? null
    );
  }

  lastAskedAt(targetSessionId: string): number | null {
    if (!this.ready()) return null;
    const row = this.db
      .prepare('SELECT MAX(asked_at) AS at FROM neo_routing_log WHERE target_session_id = ?')
      .get(targetSessionId) as { at: number | null } | null;
    return row?.at ?? null;
  }

  recent(limit: number): NeoRoute[] {
    if (!this.ready()) return [];
    return this.db
      .prepare(`SELECT ${columns} FROM neo_routing_log ORDER BY id DESC LIMIT ?`)
      .all(limit) as NeoRoute[];
  }

  latestPerProject(): NeoRoute[] {
    if (!this.ready()) return [];
    return this.db
      .prepare(
        `SELECT ${columns} FROM neo_routing_log WHERE id IN (
           SELECT MAX(id) FROM neo_routing_log GROUP BY COALESCE(concern_id, 'main'))
         ORDER BY id DESC`
      )
      .all() as NeoRoute[];
  }

  recentAsks(projectId: string, limit: number): string[] {
    if (!this.ready()) return [];
    return (
      this.db
        .prepare(
          `SELECT COALESCE(ask_summary, ask) AS ask FROM neo_routing_log
            WHERE concern_id = ? ORDER BY id DESC LIMIT ?`
        )
        .all(projectId, limit) as Array<{ ask: string }>
    ).map((row) => row.ask);
  }

  correct(messageId: string, projectId: string, targetSessionId: string): void {
    if (!this.ready()) return;
    this.db
      .prepare(
        `UPDATE neo_routing_log SET destination = 'holder', concern_id = ?,
           target_session_id = ?, signal = 'corrected', confidence = 1
          WHERE message_id = ?`
      )
      .run(projectId, targetSessionId, messageId);
  }
}
