import type { Database } from '../sqlite-compat.ts';

const TEXT_CHARS = 10_000;

export type NeoRouteDestination = 'main' | 'holder' | 'new';

export interface NeoRoute {
  id: number;
  messageId: string;
  conversationId: string;
  askedAt: number;
  ask: string;
  destination: NeoRouteDestination;
  targetSessionId: string | null;
  concernId: string | null;
  signal: string;
  confidence: number | null;
  outcome: string | null;
  outcomeAt: number | null;
  askSummary: string | null;
  awaiting: string | null;
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
  concern_id AS concernId, signal, confidence, outcome, outcome_at AS outcomeAt,
  ask_summary AS askSummary, awaiting`;

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
           target_session_id, concern_id, signal, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`
      )
      .run(
        entry.messageId,
        entry.conversationId,
        entry.askedAt,
        clip(entry.ask),
        entry.destination,
        entry.targetSessionId,
        entry.concernId,
        entry.signal,
        entry.confidence
      );
  }

  recordOutcome(messageId: string, outcome: string, at: number, notes: NeoTurnNotes = {}): void {
    if (!this.ready()) return;
    const answered = this.db
      .prepare(
        `UPDATE neo_routing_log SET outcome = ?, outcome_at = ?, digested_at = NULL,
           ask_summary = ?, awaiting = ?
          WHERE message_id = ? AND outcome IS NULL RETURNING id, destination`
      )
      .get(
        clip(outcome),
        at,
        notes.askSummary ? clip(notes.askSummary) : null,
        notes.awaiting ? clip(notes.awaiting) : null,
        messageId
      ) as { id: number; destination: string } | null;
    if (answered?.destination !== 'main') return;
    this.db
      .prepare(
        `UPDATE neo_routing_log SET digested_at = ?
          WHERE destination != 'main' AND digested_at IS NULL AND id < ?`
      )
      .run(at, answered.id);
  }

  listAfter(afterId: number, limit: number): NeoRoute[] {
    if (!this.ready()) return [];
    return this.db
      .prepare(`SELECT ${columns} FROM neo_routing_log WHERE id > ? ORDER BY id LIMIT ?`)
      .all(afterId, limit) as NeoRoute[];
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

  latest(): NeoRoute | null {
    if (!this.ready()) return null;
    return (
      (this.db
        .prepare(`SELECT ${columns} FROM neo_routing_log ORDER BY id DESC LIMIT 1`)
        .get() as NeoRoute | null) ?? null
    );
  }

  recentAsks(concernId: string, limit: number): string[] {
    if (!this.ready()) return [];
    return (
      this.db
        .prepare(
          `SELECT COALESCE(ask_summary, ask) AS ask FROM neo_routing_log
            WHERE concern_id = ? ORDER BY id DESC LIMIT ?`
        )
        .all(concernId, limit) as Array<{ ask: string }>
    ).map((row) => row.ask);
  }

  correct(messageId: string, concernId: string, targetSessionId: string): void {
    if (!this.ready()) return;
    this.db
      .prepare(
        `UPDATE neo_routing_log SET destination = 'holder', concern_id = ?,
           target_session_id = ?, signal = 'corrected', confidence = 1
          WHERE message_id = ?`
      )
      .run(concernId, targetSessionId, messageId);
  }
}
