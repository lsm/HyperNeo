/**
 * ExternalEventStore — persistent retry-aware source-level dedup
 * and per-subscription delivery lifecycle.
 *
 * Owns two tables introduced by the External Event Bus design:
 *
 *   • `space_external_events` — one row per `(spaceId, source, dedupeKey)` with
 *     a state machine (`published` → `delivered` | `failed` | `ignored`).
 *   • `space_external_event_deliveries` — per-subscription delivery rows, keyed
 *     by `(eventId, deliveryKey)`, used by the workflow runtime to advance source events
 *     to terminal `delivered` only when every expected delivery succeeds.
 *
 * Source-agnostic: nothing in this file is GitHub-specific. Topic format is
 * validated by `topic-validator.ts`; payload is opaque JSON.
 *
 * See docs/plans/design-external-event-bus-for-space-workflow-nodes.md.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
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
  type StoreResult,
  TERMINAL_DELIVERY_STATES,
  TERMINAL_EVENT_STATES,
} from './types';
import { validateLiteralTopic, validateSource } from './topic-validator';

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

export class ExternalEventStore {
  constructor(private readonly db: BunDatabase) {}

  // ---------------------------------------------------------------------------
  // Source event lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Idempotently store an external event for source-level dedup.
   *
   * - First observation: inserts a new row (state `published`) and returns
   *   `{ duplicate: false, terminal: false, event }` with the caller-supplied id.
   * - Duplicate of a *terminal* prior observation: returns
   *   `{ duplicate: true, terminal: true, event }` carrying the original id.
   *   The caller is expected to short-circuit publication.
   * - Duplicate of a *retryable* prior observation (`published`): returns
   *   `{ duplicate: true, terminal: false, event }` carrying the original id
   *   so delivery can retry.
   *
   * Validation: topic must satisfy `validateLiteralTopic`, source must be a
   * known extension identifier, and `(spaceId, dedupeKey)` must be present.
   */
  store(event: ExternalEvent): StoreResult {
    this.validate(event);
    const now = Date.now();

    const insert = this.db.prepare(
      `INSERT INTO space_external_events (
				id, space_id, source, topic, dedupe_key,
				occurred_at, ingested_at, source_event_id,
				summary, external_url, payload_json,
				state, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?,
				?, ?, ?,
				?, ?, ?,
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
      now,
      now
    );

    if (result.changes > 0) {
      return { event: { ...event }, duplicate: false, terminal: false };
    }

    // Conflict — load the canonical row and decide based on its current state.
    const existing = this.getByDedupe(event.spaceId, event.source, event.dedupeKey);
    if (!existing) {
      // Theoretically impossible — INSERT was rejected by the unique
      // constraint but the row no longer exists. Treat as fresh insert
      // retry; surface as a hard error so callers see the inconsistency.
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

  /** Return the source event row by its primary id, or `null`. */
  getById(eventId: string): ExternalEventRecord | null {
    const row = this.db.prepare(`SELECT * FROM space_external_events WHERE id = ?`).get(eventId) as
      | ExternalEventRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** Return the source event row by `(spaceId, source, dedupeKey)`, or `null`. */
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

  /**
   * Mark the source event terminal `delivered` if **every** expected delivery
   * row is in state `delivered`. No-op if the source event is already
   * terminal, or if any delivery is non-terminal or terminal-failed.
   *
   * Workflow delivery rows use this path; sources without per-workflow delivery
   * rows can call `markEventDelivered` after direct delivery succeeds.
   */
  markEventDeliveredIfAllDeliveriesDelivered(eventId: string): void {
    const event = this.getById(eventId);
    if (!event || TERMINAL_EVENT_STATES.has(event.state)) return;

    const rows = this.db
      .prepare(`SELECT state FROM space_external_event_deliveries WHERE event_id = ?`)
      .all(eventId) as Pick<ExternalEventDeliveryRow, 'state'>[];

    // Defensive: if no expected deliveries were ever registered, this is not
    // "all delivered" — the workflow runtime should call `markEventIgnored` instead.
    if (rows.length === 0) return;

    for (const row of rows) {
      if (row.state !== 'delivered') return;
    }

    this.setEventState(eventId, 'delivered');
  }

  /**
   * Mark the source event terminal `failed` if **any** delivery row is
   * terminal `failed`. No-op if the source event is already terminal.
   *
   * This guarantees a partially-failed source event is never reclassified as
   * `delivered` by a later successful subscription.
   */
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

  /**
   * Mark the source event terminal `failed` if **every** delivery row is in a
   * terminal state (delivered or failed) AND at least one is `failed`. Used
   * after retry-budget exhaustion / run-terminal-cleanup so duplicate source
   * observations do not restart an exhausted delivery.
   */
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

  /**
   * Force the source event to terminal `failed`. Used by the workflow runtime when it
   * cannot dispatch the event at all (e.g. enrichment hard error).
   *
   * `failure.terminal=false` is rejected — calling `markEventFailed` is a
   * terminal action by definition. Routes that want to retry should not call
   * this method.
   */
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

  /**
   * Mark the source event terminal `ignored`. Called when no subscriptions
   * matched, or when all matched subscriptions are already terminal.
   */
  markEventIgnored(eventId: string, _reason: 'no_matching_subscriptions'): void {
    const event = this.getById(eventId);
    if (!event || TERMINAL_EVENT_STATES.has(event.state)) return;
    this.setEventState(eventId, 'ignored');
  }

  /**
   * Internal helper to set event state without the public guard.
   * Used by terminal-transition methods that have already enforced invariants.
   */
  private setEventState(eventId: string, state: ExternalEventState): void {
    this.db
      .prepare(`UPDATE space_external_events SET state = ?, updated_at = ? WHERE id = ?`)
      .run(state, Date.now(), eventId);
  }

  // ---------------------------------------------------------------------------
  // Per-subscription delivery lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Idempotently register the delivery row expected for an event/subscription.
   *
   * Implemented as `INSERT OR IGNORE` because retryable source duplicates and
   * workflow runtime retries can prepare the same `(eventId, deliveryKey)` more than
   * once. Existing terminal rows are preserved.
   */
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
      // Reject leading/trailing whitespace so lookups keyed by canonical IDs
      // never miss these rows.
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

    // If INSERT was ignored, verify the existing row belongs to the same event
    // and has the same target fields. The unique index on delivery_key prevents
    // cross-event collisions, but this check also catches same-event target
    // mismatches (different workflowRunId/taskId/nodeId/agentName).
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

  /** Returns true when the delivery row is already terminal and should be skipped. */
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

  /**
   * Look up the source event id for a registered delivery key.
   *
   * The schema enforces a UNIQUE index on `delivery_key`, so this lookup is
   * unambiguous — a delivery key maps to exactly one event. Throws if the
   * delivery key is not registered.
   */
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

  /** Mark the delivery row terminal `delivered`. No-op if already terminal. */
  markDeliveryDelivered(eventId: string, deliveryKey: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE space_external_event_deliveries
				 SET state = 'delivered', failure_reason = NULL, delivered_at = ?, updated_at = ?
				 WHERE event_id = ? AND delivery_key = ?
				 AND state NOT IN ('delivered', 'failed')`
      )
      .run(now, now, eventId, deliveryKey);
  }

  /**
   * Mark the delivery row failed.
   *
   * `failure.terminal=true` advances to terminal `failed`. `failure.terminal=false`
   * keeps the row in `pending` (retryable) but updates `failure_reason` for
   * diagnostics — the row remains eligible for the workflow runtime's next retry pass.
   *
   * No-op if the row is already terminal.
   */
  markDeliveryFailed(eventId: string, deliveryKey: string, failure: DeliveryFailure): void {
    const now = Date.now();
    const newState: ExternalEventDeliveryState = failure.terminal ? 'failed' : 'pending';
    this.db
      .prepare(
        `UPDATE space_external_event_deliveries
				 SET state = ?, failure_reason = ?, updated_at = ?
				 WHERE event_id = ? AND delivery_key = ?
				 AND state NOT IN ('delivered', 'failed')`
      )
      .run(newState, failure.reason, now, eventId, deliveryKey);
  }

  /** List delivery rows for an event (for diagnostics and tests). */
  listDeliveries(eventId: string): ExternalEventDeliveryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_external_event_deliveries WHERE event_id = ? ORDER BY delivery_key`
      )
      .all(eventId) as ExternalEventDeliveryRow[];
    return rows.map(deliveryRowToRecord);
  }

  /** List per-subscription deliveries with source-event metadata for UI diagnostics. */
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
      // Applied in SQL so the LIMIT does not crowd out this source's rows with
      // newer failures from other external-event sources in the same Space.
      clauses.push('e.source = ?');
      params.push(filters.source);
    }

    params.push(Math.min(filters.limit ?? 100, 500), filters.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT
           d.event_id, d.delivery_key, d.workflow_run_id, d.task_id, d.node_id, d.agent_name,
           d.state, d.failure_reason, d.delivered_at, d.updated_at,
           e.id, e.space_id, e.source, e.topic, e.dedupe_key, e.occurred_at, e.ingested_at,
           e.source_event_id, e.summary, e.external_url, e.payload_json,
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

  /**
   * Count delivery-log rows matching the filters WITHOUT the display LIMIT,
   * optionally restricted to rows updated at/after a cutoff epoch. Used by the
   * GitHub health snapshot to report the true recent-failure count — the capped
   * `listDeliveryLog` would undercount a larger outage (it returns at most 5).
   */
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

  /** List published source events that have no registered delivery rows. */
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

  /** List retryable pending delivery rows, optionally scoped to a workflow run. */
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

  getDelivery(eventId: string, deliveryKey: string): ExternalEventDeliveryRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM space_external_event_deliveries
				 WHERE event_id = ? AND delivery_key = ?`
      )
      .get(eventId, deliveryKey) as ExternalEventDeliveryRow | undefined;
    return row ? deliveryRowToRecord(row) : null;
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  private validate(event: ExternalEvent): void {
    if (!event.id || typeof event.id !== 'string') {
      throw new ExternalEventValidationError('ExternalEvent.id is required');
    }
    if (!event.spaceId || typeof event.spaceId !== 'string') {
      throw new ExternalEventValidationError('ExternalEvent.spaceId is required');
    }
    if (
      !event.dedupeKey ||
      typeof event.dedupeKey !== 'string' ||
      event.dedupeKey.trim().length === 0
    ) {
      throw new ExternalEventValidationError(
        'ExternalEvent.dedupeKey is required and must not be whitespace-only'
      );
    }
    // Reject leading/trailing whitespace on dedupeKey so logically identical
    // keys (e.g. "key" vs "key ") do not bypass deduplication.
    if (event.dedupeKey !== event.dedupeKey.trim()) {
      throw new ExternalEventValidationError(
        'ExternalEvent.dedupeKey must not have leading or trailing whitespace'
      );
    }

    const sourceCheck = validateSource(event.source);
    if (!sourceCheck.valid) {
      throw new ExternalEventValidationError(`ExternalEvent.source invalid: ${sourceCheck.reason}`);
    }

    // Published events must be literal topics (no wildcards).
    const topicCheck = validateLiteralTopic(event.topic);
    if (!topicCheck.valid) {
      throw new ExternalEventValidationError(`ExternalEvent.topic invalid: ${topicCheck.reason}`);
    }

    // Topic literal must start with the declared source.
    const firstSegment = event.topic.split('/')[0];
    if (firstSegment !== event.source) {
      throw new ExternalEventValidationError(
        `ExternalEvent.topic first segment "${firstSegment}" must equal source "${event.source}"`
      );
    }

    if (typeof event.occurredAt !== 'number' || !Number.isFinite(event.occurredAt)) {
      throw new ExternalEventValidationError('ExternalEvent.occurredAt must be a finite number');
    }
    if (typeof event.ingestedAt !== 'number' || !Number.isFinite(event.ingestedAt)) {
      throw new ExternalEventValidationError('ExternalEvent.ingestedAt must be a finite number');
    }
    if (typeof event.summary !== 'string') {
      throw new ExternalEventValidationError('ExternalEvent.summary must be a string');
    }
    if (typeof event.payload !== 'object' || event.payload === null) {
      throw new ExternalEventValidationError('ExternalEvent.payload must be an object');
    }
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToRecord(row: ExternalEventRow): ExternalEventRecord {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    // Corrupted payload — return an empty object so the rest of the
    // metadata (state, dedupe key, etc.) remains usable. The workflow runtime can
    // decide whether to terminalize the event or skip delivery.
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
