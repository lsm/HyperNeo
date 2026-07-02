# Milestone 2 — RPC Protocol: `liveQuery.subscribe` / `liveQuery.unsubscribe`

**Agent:** coder
**Depends on:** Milestone 1

## Overview

Expose `LiveQueryEngine` to WebSocket clients via a named-query RPC protocol. Clients send a query
name + parameters; the daemon resolves it to a pre-registered SQL template. Clients never send raw SQL.
Naming follows `docs/adr/0001-live-query-and-job-queue.md`.

---

## Task 2.1 — Add shared protocol types

**Agent:** coder

- [ ] Create `packages/shared/src/live-query-types.ts` with these interfaces:
  ```ts
  interface LiveQuerySubscribeRequest {
    queryName: string;       // named query key from server registry
    params: unknown[];
    subscriptionId: string;  // client-chosen, unique per client connection
  }
  interface LiveQuerySubscribeResponse { ok: true }
  interface LiveQueryUnsubscribeRequest { subscriptionId: string }
  interface LiveQueryUnsubscribeResponse { ok: true }
  // Server-pushed via router.sendToClient, not broadcast
  interface LiveQuerySnapshotEvent {
    subscriptionId: string;
    rows: unknown[];
    version: number;
  }
  interface LiveQueryDeltaEvent {
    subscriptionId: string;
    added?: unknown[];
    removed?: unknown[];
    updated?: unknown[];
    version: number;
  }
  ```
- [ ] Export all types from `packages/shared/src/mod.ts`

**Acceptance criteria:**
- Types importable from `@hyperneo/shared`
- No runtime code, types only

---

## Task 2.2 — Plumb `clientId` into `CallContext`

**Agent:** coder

Steps 1–3 of the threading chain are already implemented (`HubMessageWithMetadata.clientId` is
populated by `WebSocketServerTransport` and extracted in `message-hub.ts`). Only step 4 is needed.

- [ ] Add `clientId?: string` to the `CallContext` type in `packages/shared/src/message-hub/types.ts`
- [ ] Populate `clientId` when building the `CallContext` object in `message-hub.ts` (where the
  `CallContext` is constructed from the already-extracted `clientId`)
- [ ] Unit test: `CallContext` includes `clientId` for requests arriving via WebSocket transport

**Acceptance criteria:**
- `clientId` present in `CallContext` for WebSocket-originated requests
- No breaking change to existing `CallContext` consumers (field is optional)

---

## Task 2.3 — Add `MessageHub.onClientDisconnect` forwarding method

**Agent:** coder

- [ ] Add `onClientDisconnect(handler: (clientId: string) => void): () => void` to `MessageHub`
- [ ] Implementation: retrieve primary transport using existing `this.primaryTransportName` /
  `this.transports` pattern; call `transport.onClientDisconnect(handler)`
- [ ] Guard against transports that don't implement `onClientDisconnect` (method is optional on
  `IMessageTransport`)
- [ ] Return an unsubscribe function that removes the listener
- [ ] Unit test: disconnect handler fires when a client disconnects
- [ ] Unit test: unsubscribe function prevents further callbacks

**Acceptance criteria:**
- `MessageHub` exposes `onClientDisconnect` that forwards to primary transport
- Unsubscribe function works correctly
- No-op if transport doesn't support disconnect events

---

## Task 2.4 — Define named-query registry with column aliasing and JSON parsing

**Agent:** coder

Define the server-side query registry as a module-level constant `Map` in `live-query-handlers.ts`.

- [ ] Create `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts`
- [ ] Define and export the named-query registry `Map` with these initial queries:
  - `tasks.byRoom` — `SELECT ... FROM tasks WHERE room_id = ? ORDER BY created_at DESC, id DESC`
  - `goals.byRoom` — `SELECT ... FROM goals WHERE room_id = ? ORDER BY priority DESC, created_at ASC, id ASC`
  - `sessionGroupMessages.byGroup` — `SELECT ... FROM session_group_messages WHERE group_id = ? ORDER BY created_at ASC, id ASC`
- [ ] **Column name aliasing (camelCase):** Named-query SELECT statements must use `AS` aliases
  (e.g., `room_id AS roomId`, `created_at AS createdAt`). Reference: existing repository SELECT
  mappers at `task-repository.ts` and `goal-repository.ts`
- [ ] **`RoomGoal` snake_case exception:** `planning_attempts` and `goal_review_attempts` must
  **not** be aliased to camelCase — they remain snake_case to match the TypeScript type
- [ ] **JSON blob columns:** Implement row-mapping that JSON-parses:
  - `NeoTask`: `dependsOn` (stored as `depends_on`), `linkedTaskIds` (stored as `linked_task_ids`)
  - `RoomGoal`: `linkedTaskIds` (stored as `linked_task_ids`), `metrics` (stored as `metrics`)
- [ ] Contract test: snapshot row for `tasks.byRoom` has `dependsOn` as parsed `string[]`
- [ ] Contract test: snapshot row for `goals.byRoom` has `metrics` as parsed object
- [ ] Contract test: full delivered row shape matches TypeScript types end-to-end

**Acceptance criteria:**
- Registry is exported for testability
- All column names match frontend TypeScript types exactly
- JSON blob columns are parsed before delivery
- Stable `ORDER BY` with deterministic tiebreakers on all queries

---

## Task 2.5 — Implement `liveQuery.subscribe` and `liveQuery.unsubscribe` RPC handlers

**Agent:** coder

- [ ] Implement `liveQuery.subscribe` handler:
  - Validate `clientId` is present in `CallContext`; reject with error if absent
  - Resolve `queryName` from registry; reject unknown names with clear error
  - Validate parameter count; reject mismatches with typed error
  - **Authorization checks:**
    - `tasks.byRoom` / `goals.byRoom`: verify room exists via `roomManager.getRoom(room_id)`
    - `sessionGroupMessages.byGroup`: look up `session_groups WHERE id = group_id` → get `ref_id`
      and `group_type` → for `group_type = 'task'` look up `tasks WHERE id = ref_id` → get
      `room_id` → verify room exists. Reject on any missing link.
  - Register LiveQuery subscription with engine
  - **`subscriptionId` collision:** silently replace prior subscription (dispose old handle, create new)
  - Push `liveQuery.snapshot` via `messageHub.getRouter()!.sendToClient(clientId, message)`
  - Push `liveQuery.delta` events on subsequent changes
  - Guard against null router (log and skip) and missing client (log and dispose handle)
- [ ] Implement `liveQuery.unsubscribe` handler:
  - Look up handle by `subscriptionId` for calling client
  - Dispose handle; remove from tracking
  - Return `{ ok: true }`
- [ ] **Event ordering:** Snapshot always delivered before any delta; deltas carry monotonically
  increasing `version`
- [ ] Track handles per `clientId + subscriptionId`
- [ ] Register handlers in `packages/daemon/src/lib/rpc-handlers/index.ts`
- [ ] Add `liveQueries: LiveQueryEngine` to `RPCHandlerDependencies`
- [ ] Log lifecycle events at debug level; failures at warn level

**Unit tests:**
- [ ] subscribe → snapshot → delta → unsubscribe flow
- [ ] Unknown query name rejected
- [ ] Mismatched params count rejected
- [ ] Unauthorized room_id rejected
- [ ] Unauthorized group_id rejected
- [ ] Absent clientId rejected
- [ ] subscriptionId collision replaces prior subscription
- [ ] Snapshot delivered before delta
- [ ] Version monotonically increasing

**Acceptance criteria:**
- Full subscribe/snapshot/delta/unsubscribe lifecycle works
- All validation and authorization checks enforced
- Events pushed via `sendToClient`; `daemonHub` not involved

---

## Task 2.6 — Disconnect cleanup and online tests

**Agent:** coder

- [ ] In the handler setup function (called once at server startup), register a **single**
  `messageHub.onClientDisconnect` callback that disposes all subscription handles for the
  disconnected `clientId`
  - Do NOT register per-subscribe — that leaks listeners
- [ ] Store the unsubscribe function from `onClientDisconnect`; invoke during `MessageHub`
  teardown/dispose to prevent listener leaks in test environments
- [ ] Unit test: listener count does not grow across subscribe/unsubscribe cycles
- [ ] Unit test: WebSocket disconnect disposes all subscriptions for that client
- [ ] Online test: full pipeline with real DB writes triggering deltas to a subscribed client

**Acceptance criteria:**
- WebSocket disconnect disposes all subscriptions for that client
- No listener leaks in test environments
- Online test validates end-to-end reactive pipeline
