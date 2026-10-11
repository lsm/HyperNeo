import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type {
  ExternalEvent,
  ExternalEventRecord,
  ExternalEventUrgency,
  StoreResult,
} from './types.ts';

export const SESSION_EVENT_SCOPE = 'sessions';

interface SessionEventRow {
  id: string;
  source: string;
  topic: string;
  dedupe_key: string;
  occurred_at: number;
  ingested_at: number;
  source_event_id: string | null;
  summary: string;
  external_url: string | null;
  payload_json: string;
  urgency: string | null;
  render: string | null;
  created_at: number;
}

function readPayload(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toRecord(row: SessionEventRow): ExternalEventRecord {
  const event: ExternalEvent = {
    id: row.id,
    spaceId: SESSION_EVENT_SCOPE,
    source: row.source,
    topic: row.topic,
    dedupeKey: row.dedupe_key,
    occurredAt: row.occurred_at,
    ingestedAt: row.ingested_at,
    summary: row.summary,
    payload: readPayload(row.payload_json),
    ...(row.source_event_id !== null ? { sourceEventId: row.source_event_id } : {}),
    ...(row.external_url !== null ? { externalUrl: row.external_url } : {}),
    ...(row.urgency !== null ? { urgency: row.urgency as ExternalEventUrgency } : {}),
    ...(row.render !== null ? { render: row.render } : {}),
  };
  return { event, state: 'published', createdAt: row.created_at, updatedAt: row.created_at };
}

export class SessionExternalEventStore {
  constructor(private readonly db: BunDatabase) {}

  store(event: ExternalEvent): StoreResult {
    const inserted = this.db
      .prepare(
        `INSERT INTO session_external_events (
          id, source, topic, dedupe_key, occurred_at, ingested_at, source_event_id,
          summary, external_url, payload_json, urgency, render, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, dedupe_key) DO NOTHING`
      )
      .run(
        event.id,
        event.source,
        event.topic,
        event.dedupeKey,
        event.occurredAt,
        event.ingestedAt,
        event.sourceEventId ?? null,
        event.summary,
        event.externalUrl ?? null,
        JSON.stringify(event.payload ?? {}),
        event.urgency ?? null,
        event.render ?? null,
        Date.now()
      );
    if (inserted.changes > 0) return { event: { ...event }, duplicate: false, terminal: false };
    const existing = this.db
      .prepare(`SELECT * FROM session_external_events WHERE source = ? AND dedupe_key = ?`)
      .get(event.source, event.dedupeKey) as SessionEventRow | undefined;
    if (!existing)
      throw new Error(
        `SessionExternalEventStore.store: conflict reported but no row for (${event.source}, ${event.dedupeKey})`
      );
    return { event: toRecord(existing).event, duplicate: true, terminal: true };
  }

  getById(eventId: string): ExternalEventRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM session_external_events WHERE id = ?`)
      .get(eventId) as SessionEventRow | undefined;
    return row ? toRecord(row) : null;
  }
}
