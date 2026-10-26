import { defineDbOp } from '../../storage/db-gateway/db-op.ts';
import { requireClosedPrEvent } from './session-subscription-close.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import {
  ingestExternalEvent,
  type IngestExternalEventOutcome,
} from './ingest-external-event-pipeline.ts';
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
    const record = toRecord(existing);
    return {
      event: record.event,
      duplicate: true,
      terminal: 'reason' in requireClosedPrEvent({ record }),
    };
  }

  latestPrState(subject: string): ExternalEventRecord | null {
    const prefix = `${subject.toLowerCase()}.`;
    const closed = `${prefix}closed`,
      opened = `${prefix}opened`,
      reopened = `${prefix}reopened`;
    const row = this.db
      .prepare(`SELECT * FROM session_external_events
      WHERE source = 'github' AND lower(substr(topic, 1, ?)) = ?
      AND (json_extract(payload_json, '$.eventType') = 'pull_request' OR lower(topic) IN (?, ?, ?, ?))
      AND (json_extract(payload_json, '$.state') IN ('open', 'closed') OR lower(topic) IN (?, ?, ?))
      ORDER BY occurred_at DESC, ingested_at DESC, rowid DESC LIMIT 1`)
      .get(
        prefix.length,
        prefix,
        closed,
        opened,
        reopened,
        `${prefix}polled`,
        closed,
        opened,
        reopened
      ) as SessionEventRow | undefined;
    return row ? toRecord(row) : null;
  }

  getById(eventId: string): ExternalEventRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM session_external_events WHERE id = ?`)
      .get(eventId) as SessionEventRow | undefined;
    return row ? toRecord(row) : null;
  }
}

export const ingestSessionEvent = defineDbOp({
  name: 'externalEvents.ingestSession',
  mode: 'write',
  run: (db: BunDatabase, event: ExternalEvent): IngestExternalEventOutcome => {
    const store = new SessionExternalEventStore(db);
    const outcome = ingestExternalEvent({ store: (candidate) => store.store(candidate) }, event);
    if (outcome.action === 'failed') throw outcome.error;
    return outcome;
  },
});

export const readLatestSessionPrState = defineDbOp({
  name: 'externalEvents.latestSessionPrState',
  mode: 'read',
  run: (db: BunDatabase, subject: string): ExternalEventRecord | null =>
    new SessionExternalEventStore(db).latestPrState(subject),
});
