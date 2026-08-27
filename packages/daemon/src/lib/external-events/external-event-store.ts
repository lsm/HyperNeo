import type { ReactiveDatabase } from '../../storage/reactive-database.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { DeliveryTerminalEvent, QueueAgeStats } from './queue-health-metrics.ts';
import { validateLiteralTopic, validateSource } from './topic-validator.ts';
import {
  type DeliveryFailure,
  type DeliveryTarget,
  type ExternalEvent,
  type ExternalEventDeliveryLogFilters,
  type ExternalEventDeliveryLogRecord,
  type ExternalEventDeliveryRecord,
  type ExternalEventDeliveryState,
  type ExternalEventRecord,
  type ExternalEventState,
  type ExternalEventUrgency,
  type StoreResult,
  TERMINAL_DELIVERY_STATES,
  TERMINAL_EVENT_STATES,
} from './types.ts';

interface ExternalEventRow {
  id: string;
  space_id: string;
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
  state: ExternalEventState;
  created_at: number;
  updated_at: number;
}

interface ExternalEventDeliveryRow {
  event_id: string;
  delivery_key: string;
  workflow_run_id: string;
  task_id: string;
  node_id: string;
  agent_name: string;
  state: ExternalEventDeliveryState;
  failure_reason: string | null;
  delivered_at: number | null;
  updated_at: number;
}

interface ExternalEventDeliveryLogRow extends ExternalEventDeliveryRow {
  id: string;
  space_id: string;
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
  event_state: ExternalEventState;
  event_created_at: number;
  event_updated_at: number;
}

export class ExternalEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalEventValidationError';
  }
}

const EXTERNAL_EVENT_TABLES = ['space_external_events', 'space_external_event_deliveries'] as const;

export class ExternalEventStore {
  constructor(
    private readonly db: BunDatabase,
    private readonly reactiveDb?: ReactiveDatabase
  ) {}

  private notify(tables: readonly string[] = EXTERNAL_EVENT_TABLES): void {
    if (!this.reactiveDb) return;
    for (const table of tables) this.reactiveDb.notifyChange(table);
  }

  private deliveryTerminalHook?: (event: DeliveryTerminalEvent) => void;

  private deferredEventNotifications: string[] | null = null;

  setDeliveryTerminalHook(hook: (event: DeliveryTerminalEvent) => void): void {
    this.deliveryTerminalHook = hook;
  }

  store(event: ExternalEvent): StoreResult {
    this.validate(event);
    const now = Date.now();

    const insert = this.db.prepare(
      `INSERT INTO space_external_events (
				id, space_id, source, topic, dedupe_key,
				occurred_at, ingested_at, source_event_id,
				summary, external_url, payload_json, urgency, render,
				state, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?,
				?, ?, ?,
				?, ?, ?, ?, ?,
				'published', ?, ?
			)
			ON CONFLICT(space_id, source, dedupe_key) DO NOTHING`
    );

    const result = insert.run(
      event.id,
      event.spaceId,
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
      now,
      now
    );

    if (result.changes > 0) {
      this.notify(['space_external_events']);
      return { event: { ...event }, duplicate: false, terminal: false };
    }

    const existing = this.getByDedupe(event.spaceId, event.source, event.dedupeKey);
    if (!existing) {
      throw new Error(
        `ExternalEventStore.store: conflict reported but no canonical row found ` +
          `for (${event.spaceId}, ${event.source}, ${event.dedupeKey})`
      );
    }

    return {
      event: existing.event,
      duplicate: true,
      terminal: TERMINAL_EVENT_STATES.has(existing.state),
    };
  }

  getById(eventId: string): ExternalEventRecord | null {
    const row = this.db.prepare(`SELECT * FROM space_external_events WHERE id = ?`).get(eventId) as
      | ExternalEventRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  getByDedupe(spaceId: string, source: string, dedupeKey: string): ExternalEventRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM space_external_events
				 WHERE space_id = ? AND source = ? AND dedupe_key = ?`
      )
      .get(spaceId, source, dedupeKey) as ExternalEventRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  markEventDelivered(eventId: string): void {
    const event = this.getById(eventId);
    if (!event || TERMINAL_EVENT_STATES.has(event.state)) return;
    this.setEventState(eventId, 'delivered');
  }

  markEventDeliveredIfAllDeliveriesDelivered(eventId: string): void {
    const event = this.getById(eventId);
    if (!event || TERMINAL_EVENT_STATES.has(event.state)) return;

    const rows = this.db
      .prepare(`SELECT state FROM space_external_event_deliveries WHERE event_id = ?`)
      .all(eventId) as Pick<ExternalEventDeliveryRow, 'state'>[];

    if (rows.length === 0) return;

    for (const row of rows) {
      if (row.state !== 'delivered') return;
    }

    this.setEventState(eventId, 'delivered');
  }

  markEventFailedIfAnyDeliveryTerminalFailed(eventId: string): void {
    const event = this.getById(eventId);
    if (!event || TERMINAL_EVENT_STATES.has(event.state)) return;

    const failed = this.db
      .prepare(
        `SELECT 1 FROM space_external_event_deliveries
				 WHERE event_id = ? AND state = 'failed' LIMIT 1`
      )
      .get(eventId);

    if (failed) {
      this.setEventState(eventId, 'failed');
    }
  }

  markEventFailedIfAllDeliveriesTerminal(eventId: string): void {
    const event = this.getById(eventId);
    if (!event || TERMINAL_EVENT_STATES.has(event.state)) return;

    const rows = this.db
      .prepare(`SELECT state FROM space_external_event_deliveries WHERE event_id = ?`)
      .all(eventId) as Pick<ExternalEventDeliveryRow, 'state'>[];
    if (rows.length === 0) return;

    let sawFailure = false;
    for (const row of rows) {
      if (!TERMINAL_DELIVERY_STATES.has(row.state)) return;
      if (row.state === 'failed') sawFailure = true;
    }

    if (sawFailure) {
      this.setEventState(eventId, 'failed');
    }
  }

  markEventFailed(eventId: string, failure: DeliveryFailure): void {
    if (!failure.terminal) {
      throw new Error(
        `markEventFailed requires failure.terminal=true (got false; reason="${failure.reason}")`
      );
    }
    const event = this.getById(eventId);
    if (!event || TERMINAL_EVENT_STATES.has(event.state)) return;
    this.setEventState(eventId, 'failed');
  }

  markPublishedEventsFailedBefore(createdAtBefore: number, now: number = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE space_external_events
         SET state = 'failed', updated_at = ?
         WHERE state = 'published'
           AND created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM space_external_event_deliveries d WHERE d.event_id = space_external_events.id
           )`
      )
      .run(now, createdAtBefore);
    if (result.changes > 0) this.notify(['space_external_events']);
    return result.changes ?? 0;
  }

  markEventIgnored(eventId: string, _reason: 'no_matching_subscriptions'): void {
    const event = this.getById(eventId);
    if (!event || TERMINAL_EVENT_STATES.has(event.state)) return;
    this.setEventState(eventId, 'ignored');
  }

  private setEventState(eventId: string, state: ExternalEventState): void {
    const result = this.db
      .prepare(`UPDATE space_external_events SET state = ?, updated_at = ? WHERE id = ?`)
      .run(state, Date.now(), eventId);
    if (result.changes > 0) {
      if (this.deferredEventNotifications) this.deferredEventNotifications.push(eventId);
      else this.notify(['space_external_events']);
    }
  }

  registerExpectedDelivery(eventId: string, deliveryKey: string, target: DeliveryTarget): void {
    if (!this.getById(eventId)) {
      throw new Error(`registerExpectedDelivery: unknown source event id "${eventId}"`);
    }
    if (!deliveryKey || deliveryKey.trim().length === 0) {
      throw new ExternalEventValidationError(
        `registerExpectedDelivery: deliveryKey must be non-empty (eventId="${eventId}")`
      );
    }
    for (const [key, value] of Object.entries({
      workflowRunId: target.workflowRunId,
      taskId: target.taskId,
      nodeId: target.nodeId,
      agentName: target.agentName,
    })) {
      if (!value || typeof value !== 'string' || value.trim().length === 0) {
        throw new ExternalEventValidationError(
          `registerExpectedDelivery: ${key} must be non-empty (eventId="${eventId}")`
        );
      }
      if (value !== value.trim()) {
        throw new ExternalEventValidationError(
          `registerExpectedDelivery: ${key} must not have leading or trailing whitespace ` +
            `(eventId="${eventId}")`
        );
      }
    }

    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO space_external_event_deliveries (
					event_id, delivery_key, workflow_run_id, task_id, node_id, agent_name,
					state, failure_reason, delivered_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)`
      )
      .run(
        eventId,
        deliveryKey,
        target.workflowRunId,
        target.taskId,
        target.nodeId,
        target.agentName,
        now
      );
    if (result.changes > 0) this.notify(['space_external_event_deliveries']);

    if (result.changes === 0) {
      const existingEventId = this.getEventIdForDeliveryKey(deliveryKey);
      if (existingEventId !== eventId) {
        throw new Error(
          `registerExpectedDelivery: delivery_key "${deliveryKey}" already ` +
            `registered for event "${existingEventId}", cannot register for "${eventId}"`
        );
      }
      const existing = this.getDelivery(eventId, deliveryKey);
      if (
        existing &&
        (existing.workflowRunId !== target.workflowRunId ||
          existing.taskId !== target.taskId ||
          existing.nodeId !== target.nodeId ||
          existing.agentName !== target.agentName)
      ) {
        throw new Error(
          `registerExpectedDelivery: delivery_key "${deliveryKey}" already ` +
            `registered for event "${eventId}" with different target ` +
            `(existing: ${existing.workflowRunId}/${existing.taskId}/${existing.nodeId}/${existing.agentName}, ` +
            `requested: ${target.workflowRunId}/${target.taskId}/${target.nodeId}/${target.agentName})`
        );
      }
    }
  }

  isDeliveryTerminal(eventId: string, deliveryKey: string): boolean {
    const row = this.db
      .prepare(
        `SELECT state FROM space_external_event_deliveries
				 WHERE event_id = ? AND delivery_key = ?`
      )
      .get(eventId, deliveryKey) as Pick<ExternalEventDeliveryRow, 'state'> | undefined;
    if (!row) return false;
    return TERMINAL_DELIVERY_STATES.has(row.state);
  }

  getEventIdForDeliveryKey(deliveryKey: string): string {
    const row = this.db
      .prepare(`SELECT event_id FROM space_external_event_deliveries WHERE delivery_key = ?`)
      .get(deliveryKey) as Pick<ExternalEventDeliveryRow, 'event_id'> | undefined;
    if (!row) {
      throw new Error(
        `getEventIdForDeliveryKey: no delivery row for delivery_key="${deliveryKey}"`
      );
    }
    return row.event_id;
  }

  private applyDeliveryDelivered(eventId: string, deliveryKey: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE space_external_event_deliveries
				 SET state = 'delivered', failure_reason = NULL, delivered_at = ?, updated_at = ?
				 WHERE event_id = ? AND delivery_key = ?
				 AND state NOT IN ('delivered', 'failed')`
      )
      .run(now, now, eventId, deliveryKey);
    return result.changes > 0;
  }

  private emitDeliveryDelivered(eventId: string, deliveryKey: string): void {
    this.notify();
    if (this.deliveryTerminalHook) {
      this.deliveryTerminalHook({ eventId, deliveryKey, outcome: 'delivered', reason: null });
    }
  }

  markDeliveryDelivered(eventId: string, deliveryKey: string): void {
    if (this.applyDeliveryDelivered(eventId, deliveryKey)) {
      this.emitDeliveryDelivered(eventId, deliveryKey);
    }
  }

  markDeliveriesDeliveredAtomic(marks: Array<{ eventId: string; deliveryKey: string }>): void {
    const changed: Array<{ eventId: string; deliveryKey: string }> = [];
    const deferredEventNotifications: string[] = [];
    this.deferredEventNotifications = deferredEventNotifications;
    try {
      this.db.transaction(() => {
        for (const mark of marks) {
          if (this.applyDeliveryDelivered(mark.eventId, mark.deliveryKey)) changed.push(mark);
        }
        for (const mark of marks) {
          this.markEventDeliveredIfAllDeliveriesDelivered(mark.eventId);
          this.markEventFailedIfAllDeliveriesTerminal(mark.eventId);
        }
      })();
    } finally {
      this.deferredEventNotifications = null;
    }
    if (deferredEventNotifications.length > 0) {
      this.notify(['space_external_events']);
    }
    for (const mark of changed) {
      this.emitDeliveryDelivered(mark.eventId, mark.deliveryKey);
    }
  }

  markDeliveryFailed(eventId: string, deliveryKey: string, failure: DeliveryFailure): void {
    const now = Date.now();
    const newState: ExternalEventDeliveryState = failure.terminal ? 'failed' : 'pending';
    const result = this.db
      .prepare(
        `UPDATE space_external_event_deliveries
				 SET state = ?, failure_reason = ?, updated_at = ?
				 WHERE event_id = ? AND delivery_key = ?
				 AND state NOT IN ('delivered', 'failed')`
      )
      .run(newState, failure.reason, now, eventId, deliveryKey);
    if (result.changes > 0) {
      this.notify();
      if (failure.terminal && this.deliveryTerminalHook) {
        this.deliveryTerminalHook({
          eventId,
          deliveryKey,
          outcome: 'failed',
          reason: failure.reason,
        });
      }
    }
  }

  listDeliveries(eventId: string): ExternalEventDeliveryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_external_event_deliveries WHERE event_id = ? ORDER BY delivery_key`
      )
      .all(eventId) as ExternalEventDeliveryRow[];
    return rows.map(deliveryRowToRecord);
  }

  listDeliveryLog(filters: ExternalEventDeliveryLogFilters): ExternalEventDeliveryLogRecord[] {
    if (!filters.spaceId || filters.spaceId.trim().length === 0) {
      throw new ExternalEventValidationError('listDeliveryLog: spaceId is required');
    }
    if (filters.limit !== undefined && (!Number.isInteger(filters.limit) || filters.limit <= 0)) {
      throw new ExternalEventValidationError('listDeliveryLog: limit must be a positive integer');
    }
    if (filters.offset !== undefined && (!Number.isInteger(filters.offset) || filters.offset < 0)) {
      throw new ExternalEventValidationError(
        'listDeliveryLog: offset must be a non-negative integer'
      );
    }

    const clauses = ['e.space_id = ?'];
    const params: Array<string | number> = [filters.spaceId];
    if (filters.status) {
      clauses.push('d.state = ?');
      params.push(filters.status);
    }
    if (filters.eventId) {
      clauses.push('d.event_id = ?');
      params.push(filters.eventId);
    }
    if (filters.agentName) {
      clauses.push('d.agent_name = ?');
      params.push(filters.agentName);
    }
    if (filters.source) {
      clauses.push('e.source = ?');
      params.push(filters.source);
    }
    if (filters.workflowRunId) {
      clauses.push('d.workflow_run_id = ?');
      params.push(filters.workflowRunId);
    }
    if (filters.nodeId) {
      clauses.push('d.node_id = ?');
      params.push(filters.nodeId);
    }

    params.push(Math.min(filters.limit ?? 100, 500), filters.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT
           d.event_id, d.delivery_key, d.workflow_run_id, d.task_id, d.node_id, d.agent_name,
           d.state, d.failure_reason, d.delivered_at, d.updated_at,
           e.id, e.space_id, e.source, e.topic, e.dedupe_key, e.occurred_at, e.ingested_at,
           e.source_event_id, e.summary, e.external_url, e.payload_json, e.urgency, e.render,
           e.state AS event_state, e.created_at AS event_created_at, e.updated_at AS event_updated_at
         FROM space_external_event_deliveries d
         INNER JOIN space_external_events e ON e.id = d.event_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY d.updated_at DESC, d.delivery_key
         LIMIT ? OFFSET ?`
      )
      .all(...params) as ExternalEventDeliveryLogRow[];
    return rows.map(deliveryLogRowToRecord);
  }

  countDeliveryLog(filters: {
    spaceId: string;
    status?: string;
    source?: string;
    updatedSince?: number;
  }): number {
    if (!filters.spaceId || filters.spaceId.trim().length === 0) {
      throw new ExternalEventValidationError('countDeliveryLog: spaceId is required');
    }
    const clauses = ['e.space_id = ?'];
    const params: Array<string | number> = [filters.spaceId];
    if (filters.status) {
      clauses.push('d.state = ?');
      params.push(filters.status);
    }
    if (filters.source) {
      clauses.push('e.source = ?');
      params.push(filters.source);
    }
    if (filters.updatedSince !== undefined) {
      clauses.push('d.updated_at >= ?');
      params.push(filters.updatedSince);
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM space_external_event_deliveries d
         INNER JOIN space_external_events e ON e.id = d.event_id
         WHERE ${clauses.join(' AND ')}`
      )
      .get(...params) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  listEventCountsByTopic(filters: {
    spaceId: string;
    source?: string;
    since?: number;
  }): Array<{ topic: string; count: number; lastAt: number }> {
    if (!filters.spaceId || filters.spaceId.trim().length === 0) {
      throw new ExternalEventValidationError('listEventCountsByTopic: spaceId is required');
    }
    const clauses = ['space_id = ?'];
    const params: Array<string | number> = [filters.spaceId];
    if (filters.source) {
      clauses.push('source = ?');
      params.push(filters.source);
    }
    if (filters.since !== undefined) {
      clauses.push('ingested_at >= ?');
      params.push(filters.since);
    }
    const rows = this.db
      .prepare(
        `SELECT topic, COUNT(*) AS count, MAX(ingested_at) AS lastAt
         FROM space_external_events
         WHERE ${clauses.join(' AND ')}
         GROUP BY topic`
      )
      .all(...params) as Array<{ topic: string; count: number; lastAt: number }>;
    return rows;
  }

  listPublishedEventsWithoutDeliveries(): ExternalEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM space_external_events e
				 WHERE e.state = 'published'
				   AND NOT EXISTS (
				     SELECT 1 FROM space_external_event_deliveries d WHERE d.event_id = e.id
				   )
				 ORDER BY e.updated_at, e.id`
      )
      .all() as ExternalEventRow[];
    return rows.map(rowToRecord);
  }

  listPendingDeliveries(workflowRunId?: string): ExternalEventDeliveryRecord[] {
    const rows = workflowRunId
      ? (this.db
          .prepare(
            `SELECT * FROM space_external_event_deliveries
						 WHERE state = 'pending' AND workflow_run_id = ?
						 ORDER BY updated_at, delivery_key`
          )
          .all(workflowRunId) as ExternalEventDeliveryRow[])
      : (this.db
          .prepare(
            `SELECT * FROM space_external_event_deliveries
						 WHERE state = 'pending'
						 ORDER BY updated_at, delivery_key`
          )
          .all() as ExternalEventDeliveryRow[]);
    return rows.map(deliveryRowToRecord);
  }

  summarizePendingDeliveries(now: number = Date.now()): QueueAgeStats | null {
    const agg = this.db
      .prepare(
        `SELECT
           COUNT(*) AS count,
           MIN(? - e.created_at) AS minMs,
           MAX(? - e.created_at) AS maxMs,
           AVG(? - e.created_at) AS avgMs
         FROM space_external_event_deliveries d
         INNER JOIN space_external_events e ON e.id = d.event_id
         WHERE d.state = 'pending'`
      )
      .get(now, now, now) as {
      count: number;
      minMs: number | null;
      maxMs: number | null;
      avgMs: number | null;
    };
    const count = agg?.count ?? 0;
    if (count === 0) return null;
    const p95Offset = Math.min(count - 1, Math.ceil(count * 0.95) - 1);
    const p95 = this.db
      .prepare(
        `SELECT (? - e.created_at) AS age
           FROM space_external_event_deliveries d
           INNER JOIN space_external_events e ON e.id = d.event_id
           WHERE d.state = 'pending'
           ORDER BY age
           LIMIT 1 OFFSET ?`
      )
      .get(now, p95Offset) as { age: number } | undefined;
    return {
      count,
      minMs: agg.minMs ?? 0,
      maxMs: agg.maxMs ?? 0,
      avgMs: Math.round(agg.avgMs ?? 0),
      p95Ms: p95?.age ?? agg.maxMs ?? 0,
    };
  }

  getDelivery(eventId: string, deliveryKey: string): ExternalEventDeliveryRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM space_external_event_deliveries
				 WHERE event_id = ? AND delivery_key = ?`
      )
      .get(eventId, deliveryKey) as ExternalEventDeliveryRow | undefined;
    return row ? deliveryRowToRecord(row) : null;
  }

  private validate(event: ExternalEvent): void {
    const reason = validateExternalEvent(event);
    if (reason !== null) {
      throw new ExternalEventValidationError(reason);
    }
  }
}

export function validateExternalEvent(event: ExternalEvent): string | null {
  if (!event.id || typeof event.id !== 'string') return 'ExternalEvent.id is required';
  if (!event.spaceId || typeof event.spaceId !== 'string') {
    return 'ExternalEvent.spaceId is required';
  }
  if (
    !event.dedupeKey ||
    typeof event.dedupeKey !== 'string' ||
    event.dedupeKey.trim().length === 0
  ) {
    return 'ExternalEvent.dedupeKey is required and must not be whitespace-only';
  }
  if (event.dedupeKey !== event.dedupeKey.trim()) {
    return 'ExternalEvent.dedupeKey must not have leading or trailing whitespace';
  }

  const sourceCheck = validateSource(event.source);
  if (!sourceCheck.valid) return `ExternalEvent.source invalid: ${sourceCheck.reason}`;

  const topicCheck = validateLiteralTopic(event.topic);
  if (!topicCheck.valid) return `ExternalEvent.topic invalid: ${topicCheck.reason}`;

  const firstSegment = event.topic.split('/')[0];
  if (firstSegment !== event.source) {
    return `ExternalEvent.topic first segment "${firstSegment}" must equal source "${event.source}"`;
  }

  if (typeof event.occurredAt !== 'number' || !Number.isFinite(event.occurredAt)) {
    return 'ExternalEvent.occurredAt must be a finite number';
  }
  if (typeof event.ingestedAt !== 'number' || !Number.isFinite(event.ingestedAt)) {
    return 'ExternalEvent.ingestedAt must be a finite number';
  }
  if (typeof event.summary !== 'string') return 'ExternalEvent.summary must be a string';
  if (typeof event.payload !== 'object' || event.payload === null) {
    return 'ExternalEvent.payload must be an object';
  }
  return null;
}

function rowToRecord(row: ExternalEventRow): ExternalEventRecord {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }

  const event: ExternalEvent = {
    id: row.id,
    spaceId: row.space_id,
    source: row.source,
    topic: row.topic,
    dedupeKey: row.dedupe_key,
    occurredAt: row.occurred_at,
    ingestedAt: row.ingested_at,
    summary: row.summary,
    payload,
  };
  if (row.source_event_id !== null) event.sourceEventId = row.source_event_id;
  if (row.external_url !== null) event.externalUrl = row.external_url;
  if (row.urgency !== null) event.urgency = row.urgency as ExternalEventUrgency;
  if (row.render !== null) event.render = row.render;

  return {
    event,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deliveryRowToRecord(row: ExternalEventDeliveryRow): ExternalEventDeliveryRecord {
  return {
    eventId: row.event_id,
    deliveryKey: row.delivery_key,
    workflowRunId: row.workflow_run_id,
    taskId: row.task_id,
    nodeId: row.node_id,
    agentName: row.agent_name,
    state: row.state,
    failureReason: row.failure_reason,
    deliveredAt: row.delivered_at,
    updatedAt: row.updated_at,
  };
}

function deliveryLogRowToRecord(row: ExternalEventDeliveryLogRow): ExternalEventDeliveryLogRecord {
  const eventRecord = rowToRecord({
    id: row.id,
    space_id: row.space_id,
    source: row.source,
    topic: row.topic,
    dedupe_key: row.dedupe_key,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    source_event_id: row.source_event_id,
    summary: row.summary,
    external_url: row.external_url,
    payload_json: row.payload_json,
    urgency: row.urgency,
    render: row.render,
    state: row.event_state,
    created_at: row.event_created_at,
    updated_at: row.event_updated_at,
  });
  return {
    ...deliveryRowToRecord(row),
    event: eventRecord.event,
    eventState: eventRecord.state,
    eventCreatedAt: eventRecord.createdAt,
    eventUpdatedAt: eventRecord.updatedAt,
  };
}
