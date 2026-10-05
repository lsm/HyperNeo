import type { Database } from '../sqlite-compat.ts';

const TEXT_CHARS = 300;

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
}

export type NeoRouteEntry = Omit<NeoRoute, 'id' | 'outcome' | 'outcomeAt'>;

const columns = `id, message_id AS messageId, conversation_id AS conversationId,
  asked_at AS askedAt, ask, destination, target_session_id AS targetSessionId,
  concern_id AS concernId, signal, confidence, outcome, outcome_at AS outcomeAt`;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TEXT_CHARS ? `${flat.slice(0, TEXT_CHARS)}…` : flat;
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

  recordOutcome(messageId: string, outcome: string, at: number): void {
    if (!this.ready()) return;
    this.db
      .prepare(
        `UPDATE neo_routing_log SET outcome = ?, outcome_at = ?
          WHERE message_id = ? AND outcome IS NULL`
      )
      .run(clip(outcome), at, messageId);
  }

  listAfter(afterId: number, limit: number): NeoRoute[] {
    if (!this.ready()) return [];
    return this.db
      .prepare(`SELECT ${columns} FROM neo_routing_log WHERE id > ? ORDER BY id LIMIT ?`)
      .all(afterId, limit) as NeoRoute[];
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
        .prepare(`SELECT ask FROM neo_routing_log WHERE concern_id = ? ORDER BY id DESC LIMIT ?`)
        .all(concernId, limit) as Array<{ ask: string }>
    ).map((row) => row.ask);
  }
}
