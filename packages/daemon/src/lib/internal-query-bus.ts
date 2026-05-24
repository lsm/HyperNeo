/**
 * InternalQueryBus — Semantic daemon query primitive (v1)
 *
 * First-class facade for typed internal queries with explicit one-handler-per-query
 * semantics. Queries are requests to read state; they are not domain events and
 * must not produce side effects as part of normal execution.
 *
 * Relationship to Live Query
 * --------------------------
 * InternalQueryBus serves *explicit* point-in-time reads: a caller asks a
 * question and receives an answer.  LiveQueryEngine / ReactiveDatabase serve
 * *reactive* reads: a caller subscribes to a SQL query and receives
 * snapshot/delta updates whenever underlying tables change.
 *
 * These two systems are complementary, not overlapping:
 *   • InternalQueryBus    → imperative "get me X now" (e.g. `space.workflowRun.get`)
 *   • LiveQueryEngine     → reactive "tell me when Y changes" (e.g. `sessions.list`)
 *
 * Live Query remains reactive read-model/query-update plumbing.  It must not be
 * used as a general domain event bus, command channel, or side-effect trigger.
 * InternalQueryBus handlers may read from the same repositories or projected
 * state that Live Query watches, but they do not replace Live Query's push
 * semantics.
 *
 * Design constraints (v1)
 * -----------------------
 * • One owner/handler per query — duplicate registration is rejected.
 * • No middleware — cross-cutting concerns stay explicit in handlers.
 * • Structured results — every execute returns a `QueryResult<T>`.
 * • Typed query map — domain code defines queries through a `TQueryMap`.
 * • Missing and failed handlers return structured failures (never throw).
 *
 * Future direction
 * ----------------
 * See docs/plans/internal-event-command-query-architecture.md for the full
 * internal-event / command / query architecture plan.
 */

/**
 * Structured result returned by every query execution.
 *
 * On success `ok` is `true` and `data` contains the handler's return value.
 * On failure `ok` is `false` and `error` carries the reason (missing handler,
 * handler threw, etc).
 */
export interface QueryResult<T = unknown> {
  /** Whether the query handler completed successfully. */
  ok: boolean;

  /** The result payload when `ok` is true. */
  data?: T;

  /** Error payload when `ok` is false. */
  error?: unknown;
}

/**
 * Thrown when a query handler is registered for a name that already
 * has an owner.  This is thrown at registration time, not execution time.
 */
export class DuplicateQueryHandlerError extends Error {
  constructor(public readonly queryName: string) {
    super(`Query '${queryName}' already has a registered handler`);
    this.name = 'DuplicateQueryHandlerError';
  }
}

/**
 * Carried in `QueryResult.error` when `execute(...)` is called for a query
 * with no registered handler.  Returned as a structured failure rather than
 * thrown so callers can handle missing queries gracefully.
 */
export class MissingQueryHandlerError extends Error {
  constructor(public readonly queryName: string) {
    super(`No handler registered for query '${queryName}'`);
    this.name = 'MissingQueryHandlerError';
  }
}

export type QueryHandler<TInput, TOutput> = (query: TInput) => Promise<TOutput>;

interface RegisteredQueryHandler {
  handler: (query: unknown) => Promise<unknown>;
}

/** Extract the input type for a given query map entry. */
type QueryInput<TQueryMap, K extends keyof TQueryMap> = TQueryMap[K] extends {
  input: infer I;
}
  ? I
  : never;

/** Extract the output type for a given query map entry. */
type QueryOutput<TQueryMap, K extends keyof TQueryMap> = TQueryMap[K] extends {
  output: infer O;
}
  ? O
  : never;

/**
 * InternalQueryBus
 *
 * @template TQueryMap — map of dot-separated query names to `{ input, output }` shapes.
 *
 * Example query map entry:
 *   'space.workflowRun.get': { input: { runId: string }; output: WorkflowRun | null }
 */
export class InternalQueryBus<
  TQueryMap extends object = Record<string, { input: unknown; output: unknown }>,
> {
  private handlers = new Map<string, RegisteredQueryHandler>();

  /**
   * Register a handler for a query.
   *
   * @param queryName — typed query name
   * @param handler   — callback invoked when the query is executed
   * @returns unsubscribe function
   * @throws DuplicateQueryHandlerError if a handler already exists for this query
   */
  register<K extends keyof TQueryMap & string>(
    queryName: K,
    handler: QueryHandler<QueryInput<TQueryMap, K>, QueryOutput<TQueryMap, K>>
  ): () => void {
    const key = queryName;

    if (this.handlers.has(key)) {
      throw new DuplicateQueryHandlerError(key);
    }

    const registered: RegisteredQueryHandler = {
      handler: handler as (query: unknown) => Promise<unknown>,
    };

    this.handlers.set(key, registered);

    return () => {
      const current = this.handlers.get(key);
      if (current === registered) {
        this.handlers.delete(key);
      }
    };
  }

  /**
   * Execute a query through its registered handler and await the result.
   *
   * @param queryName — typed query name
   * @param query     — query payload
   * @returns structured `QueryResult<TOutput>`
   *
   * Returns `{ ok: false, error: MissingQueryHandlerError }` when no handler
   * is registered.  Handler throws are caught and returned as
   * `{ ok: false, error }` so callers never need to try/catch execute().
   */
  async execute<K extends keyof TQueryMap & string>(
    queryName: K,
    query: QueryInput<TQueryMap, K>
  ): Promise<QueryResult<QueryOutput<TQueryMap, K>>> {
    const key = queryName;
    const registered = this.handlers.get(key);

    if (!registered) {
      return { ok: false, error: new MissingQueryHandlerError(key) };
    }

    try {
      const data = (await registered.handler(query)) as QueryOutput<TQueryMap, K>;
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /**
   * Return true if a handler is registered for the given query name.
   */
  hasHandler<K extends keyof TQueryMap & string>(queryName: K): boolean {
    return this.handlers.has(queryName);
  }

  /**
   * Remove the handler for a specific query.
   */
  unregister<K extends keyof TQueryMap & string>(queryName: K): void {
    this.handlers.delete(queryName);
  }

  /**
   * Remove all handlers.
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Return the number of registered handlers.
   */
  getHandlerCount(): number {
    return this.handlers.size;
  }
}

/**
 * Convenience factory that produces an InternalQueryBus typed with the
 * caller's query map.
 *
 * This is the entry point most daemon code should use:
 *
 *   import { createInternalQueryBus } from '@neokai/daemon/lib/internal-query-bus';
 *   const bus = createInternalQueryBus<MyQueryMap>();
 */
export function createInternalQueryBus<
  TQueryMap extends object = Record<string, { input: unknown; output: unknown }>,
>(): InternalQueryBus<TQueryMap> {
  return new InternalQueryBus<TQueryMap>();
}

// ---------------------------------------------------------------------------
// Query contracts — canonical payloads for queries used across the daemon.
// Expand this map as new queries are added; keep each domain's queries
// in a separate interface and intersect them here.
// ---------------------------------------------------------------------------

/**
 * Payload for `space.workflowRun.get` — fetch a single workflow run by id.
 */
export interface SpaceWorkflowRunGetQuery {
  /** Workflow run identifier. */
  runId: string;
}

/**
 * Result for `space.workflowRun.get`.
 */
export interface SpaceWorkflowRunGetResult {
  /** The run, or null if not found. */
  run: Record<string, unknown> | null;
}

/**
 * Payload for `room.tasks.list` — list tasks in a room.
 */
export interface RoomTasksListQuery {
  /** Room identifier. */
  roomId: string;
  /** Include archived tasks. */
  includeArchived?: boolean;
}

/**
 * Result for `room.tasks.list`.
 */
export interface RoomTasksListResult {
  /** Task summaries. */
  tasks: Array<Record<string, unknown>>;
}

/**
 * Canonical daemon query map.
 *
 * Each domain should own its slice; this type is the intersection of all
 * domain query maps so the bus can be typed with the full surface.
 */
export interface DaemonQueryMap {
  'space.workflowRun.get': { input: SpaceWorkflowRunGetQuery; output: SpaceWorkflowRunGetResult };
  'room.tasks.list': { input: RoomTasksListQuery; output: RoomTasksListResult };
}
