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

import type { ReactiveDatabase } from '../../storage/reactive-database';
import type { Database as BunDatabase } from '../../storage/sqlite-compat';
import type { DeliveryTerminalEvent, QueueAgeStats } from './queue-health-metrics';
import { validateLiteralTopic, validateSource } from './topic-validator';
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

/** Tables owned by this store, used for reactive invalidation. */
const EXTERNAL_EVENT_TABLES = ['space_external_events', 'space_external_event_deliveries'] as const;

export class ExternalEventStore {
  constructor(
    private readonly db: BunDatabase,
    private readonly reactiveDb?: ReactiveDatabase
  ) {}

  /**
   * Notify reactive LiveQuery consumers that one or both owned tables changed.
   * This store writes via raw SQL (bypassing the reactive proxy), so without
   * these notifications task timelines and other live views that read
   * `space_external_events` / `space_external_event_deliveries` go stale until
   * an unrelated watched-table write happens.
   */
  private notify(tables: readonly string[] = EXTERNAL_EVENT_TABLES): void {
    if (!this.reactiveDb) return;
    for (const table of tables) this.reactiveDb.notifyChange(table);
  }

  /**
   * Optional hook fired when a delivery row transitions to a terminal state
   * (`delivered`, or `failed` via `failure.terminal=true`). Set by the space
   * runtime so queue-health metrics can count every delivery outcome from a
   * single observation point, regardless of which call path reached the
   * transition. Only fired on an actual transition (`changes > 0`).
   */
  private deliveryTerminalHook?: (event: DeliveryTerminalEvent) => void;

  /** Install the delivery-terminal observation hook. */
  setDeliveryTerminalHook(hook: (event: DeliveryTerminalEvent) => void): void {
    this.deliveryTerminalHook = hook;
  }

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
      this.notify(['space_external_events']);
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
    const result = this.db
      .prepare(`UPDATE space_external_events SET state = ?, updated_at = ? WHERE id = ?`)
      .run(state, Date.now(), eventId);
    if (result.changes > 0) this.notify(['space_external_events']);
  }

  // ---------------------------------------------------------------------------
  // Per-subscription delivery lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Reopen a TERMINAL source event (`delivered`/`failed`) back to `published`.
   * No-op for non-terminal sources and unknown events. The late-target replay
   * path composes this with delivery registration atomically — see
   * {@link reopenTerminalEventWithDelivery}.
   */
  reopenTerminalEvent(eventId: string): void {
    const event = this.getById(eventId);
    if (!event || !TERMINAL_EVENT_STATES.has(event.state)) return;
    this.setEventState(eventId, 'published');
  }

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
    if (result.changes > 0) this.notify(['space_external_event_deliveries']);

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

  /**
   * Reopen a TERMINAL source event (`delivered`/`failed`) back to `published` and
   * register the new expected delivery, in ONE transaction.
   *
   * Used by the late-target replay path: once a pending row exists, aggregate
   * transitions (markEventDeliveredIfAllDeliveriesDelivered /
   * markEventFailedIfAllDeliveriesTerminal) advance the source to reflect EVERY
   * expected delivery, so leaving it terminal would freeze a false success/failure
   * — dedup and event-level diagnostics would report settled state while the late
   * delivery is still outstanding. Atomicity matters because the reopen must
   * never persist without its delivery row: a crash between the two statements
   * would leave a falsely-`published` source whose only delivery rows are the old
   * terminal ones — invisible to every recovery sweep (the TTL sweep only scans
   * events without deliveries; the new-target query excludes rows past its
   * cutoff), retained indefinitely. The reopen is a no-op for non-terminal
   * sources (the normal retained case); unknown events still throw via
   * registerExpectedDelivery's validation.
   */
  reopenTerminalEventWithDelivery(
    eventId: string,
    deliveryKey: string,
    target: DeliveryTarget
  ): void {
    const tx = this.db.transaction(() => {
      this.reopenTerminalEvent(eventId);
      this.registerExpectedDelivery(eventId, deliveryKey, target);
    });
    tx();
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
    const result = this.db
      .prepare(
        `UPDATE space_external_event_deliveries
				 SET state = 'delivered', failure_reason = NULL, delivered_at = ?, updated_at = ?
				 WHERE event_id = ? AND delivery_key = ?
				 AND state NOT IN ('delivered', 'failed')`
      )
      .run(now, now, eventId, deliveryKey);
    if (result.changes > 0) {
      this.notify();
      if (this.deliveryTerminalHook) {
        this.deliveryTerminalHook({ eventId, deliveryKey, outcome: 'delivered', reason: null });
      }
    }
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

  /**
   * Count ingested source events in a recency window, grouped by topic, with
   * the most recent `ingested_at` per topic. Source-agnostic: a source-specific
   * health UI reduces these raw topic buckets into named event types (by the
   * topic-action suffix) without this store parsing any source's payload.
   *
   * Uses `ingested_at` (when the daemon first stored the row), not `occurred_at`
   * (when GitHub says the event happened): this is a *recent ingestion* health
   * metric, so a webhook delayed days after its GitHub timestamp still counts as
   * fresh traffic the moment it first lands. `ingested_at` is first-ingestion
   * time — `store()` is `DO NOTHING` on a duplicate dedupe key, so a GitHub
   * *redelivery* of an already-seen event does NOT refresh it, and a replay of
   * an event first ingested outside the window won't appear here. That's
   * intentional: a redelivery is a re-receipt of an already-deduped event, not
   * new traffic for this path-health signal. Counts every state — a row's
   * presence means the event was ingested, which is the signal a health panel
   * wants (delivery outcome is irrelevant to "is this ingest path seeing
   * traffic"). Grouping is by full topic in SQL (SQLite exposes no last-index-of
   * to split the action suffix in-engine); the caller reduces to suffixes in JS.
   * Bounded by the recency window, this is a small single-space result for a
   * per-space snapshot.
   */
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

  /**
   * List published source events that already have at least one delivery row.
   * These were routed to some target while retained `published` (a delivery to
   * target A is non-terminal, so the event stays published). Used to replay a
   * newly-materialized subscription (e.g. a topicFrom interest registered
   * mid-run) against such events so the new target still receives them, while
   * the no-delivery replay (listPublishedEventsWithoutDeliveries) handles the
   * pure-gap case. Per-target delivery dedup (deliveryKey + terminal/in-flight
   * guards) ensures only targets without an existing delivery are dispatched.
   *
   * Pass `spaceId` to scope the scan to one space (the per-run materialization
   * trigger knows its space); omit it for a global flush. Pass `createdAfterMs`
   * to skip rows older than a TTL cutoff at the SQL layer (the new-target replay
   * re-checks expiry in JS regardless, but this keeps expired-but-not-terminalized
   * rows out of the result set so the scoped index scan doesn't fetch them).
   *
   * When `createdAfterMs` is provided, RECENT terminal rows are also included —
   * both `delivered` and `failed`:
   * - `delivered`: an event that matched a live target before a topicFrom target
   *   materialized terminalizes once that delivery settles; a PR link recorded
   *   moments later must still reach the late target within the window.
   * - `failed`: an event whose FIRST target failed per-target delivery handling
   *   (terminalized via markEventFailedIfAllDeliveriesTerminal, which requires
   *   delivery rows) misses the late target otherwise. Pre-routing failures
   *   (markEventFailed / markEventIgnored) never created delivery rows, so the
   *   EXISTS clause below excludes them — replaying those is a retry of a
   *   routing-time decision, not a late subscription.
   * Without the cutoff (unbounded global flush) terminal rows are excluded —
   * replaying the full terminal history is both unbounded and redundant with
   * restart requeue.
   */
  listPublishedEventsWithDeliveries(
    spaceId?: string,
    createdAfterMs?: number
  ): ExternalEventRecord[] {
    const cutoff = typeof createdAfterMs === 'number' ? createdAfterMs : null;
    // Terminal rows (delivered, or failed via per-target delivery handling)
    // are eligible only inside the TTL window; published rows scan as before
    // (the JS expiry guard still applies to them).
    const stateFilter =
      cutoff !== null
        ? `(e.state = 'published' OR (e.state IN ('delivered','failed') AND e.created_at > ?))`
        : `e.state = 'published'`;
    const rows = spaceId
      ? (this.db
          .prepare(
            `SELECT e.* FROM space_external_events e
 				 WHERE ${stateFilter}
 				   AND e.space_id = ?
 				   ${cutoff !== null ? 'AND e.created_at > ?' : ''}
 				   AND EXISTS (
 				     SELECT 1 FROM space_external_event_deliveries d WHERE d.event_id = e.id
 				   )
 				 ORDER BY e.updated_at, e.id`
          )
          .all(...(cutoff !== null ? [cutoff, spaceId, cutoff] : [spaceId])) as ExternalEventRow[])
      : (this.db
          .prepare(
            `SELECT e.* FROM space_external_events e
 				 WHERE ${stateFilter}
 				   ${cutoff !== null ? 'AND e.created_at > ?' : ''}
 				   AND EXISTS (
 				     SELECT 1 FROM space_external_event_deliveries d WHERE d.event_id = e.id
 				   )
 				 ORDER BY e.updated_at, e.id`
          )
          .all(...(cutoff !== null ? [cutoff, cutoff] : [])) as ExternalEventRow[]);
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

  /**
   * Summarize DB-persisted `pending` deliveries for the queue-health snapshot
   * without materializing every row: count + min/max/avg via SQL aggregates, and
   * p95 via a single `LIMIT 1 OFFSET k` lookup over a sorted scan (no per-row JS
   * allocation). The anchor is the source event's ingestion time
   * (`space_external_events.created_at`), matching the runtime's event-age TTL
   * semantics — see `EXTERNAL_EVENT_QUEUE_TTL_MS`. Returns `null` when there are
   * no pending deliveries.
   */
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
    // Nearest-rank p95 (no interpolation): the ceil(0.95 * n)th value, clamped.
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
