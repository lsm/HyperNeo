# Space Actor Communication Design

Status: Proposed
Date: 2026-05-16
Task: #401 — Design universal Space actor communication model

## Summary

Use a small actor-addressed messaging substrate for the Space features we already have:

- Space chat / Coordinator
- ad-hoc Space sessions
- current task messaging compatibility
- workflow node agent messaging
- pending worker delivery
- role escalation such as task-manager

The substrate should be generic enough to support long-term agents, inter-Space communication, and
inter-domain communication later, but v1 should not introduce a full Slack clone or task/workflow
chat threads.

## Core decision

Build one generic **Messaging** service/package boundary, then adapt Space to it.

Recommended boundary:

- `packages/messaging` or equivalent daemon-internal package first if package split is too early.
- Owns protocol types, address parsing, resolver contracts, message/delivery shapes, and audit event
  shapes.
- Does not own Space-specific storage, workflow activation, gates, or UI policy.
- Space runtime implements domain adapters: actor resolver, permission checks, delivery executor, and
  activation hooks.

This avoids baking generic actor messaging into `packages/daemon/src/lib/space/*` and keeps future
inter-Space / inter-domain routing from requiring a ground-up rewrite.

## What v1 must cover

Current behavior must keep working:

| Current feature | v1 generic mapping |
| --- | --- |
| Space Agent / default space chat agent | `agent` actor with `coordinator` role and `@coordinator` handle |
| Human Space chat / ad-hoc session | `session` actor with `@session:<id>` address |
| New persistent role agents | `agent` actor with handle and optional roles |
| Workflow node agent / coder / reviewer | `worker` actor, scoped by `workflowRunId` + `nodeId` + `agentName` |
| `node-agent send_message` | wrapper around generic `send_message` |
| task message RPC/tooling | compatibility wrapper around generic `send_message` |
| `pending_agent_messages` | legacy delivery queue (removed; deliveries project from the session mailbox outbox) |
| task/workflow message UI | projection of messages/events; not LLM chat thread |

## Non-goals for v1

Do not build these now:

- Full channel system beyond existing Space/session/task surfaces.
- Public `conversation:<id>` target syntax.
- Task threads or workflow threads as LLM-visible chat surfaces.
- Cross-Space delivery implementation.
- Cross-domain delivery implementation.
- General federation, external identity proof, or trust negotiation.

Design data shapes so those can be added later through adapters.

## Minimal concepts

### Actor

Actor = addressable identity.

```ts
type ActorKind = 'human' | 'session' | 'agent' | 'worker' | 'system';

type ActorRef = {
	actorId: string;
	kind: ActorKind;
	spaceId: string;
	handle?: string; // @coordinator, @task-manager
	roles?: string[]; // coordinator, task-manager, reviewer
	status: 'active' | 'inactive' | 'archived' | 'deleted';
};
```

Notes:

- `agent` covers persistent non-human Space actors. Coordinator is an agent role/handle, not a separate
  kind: `{ kind: 'agent', handle: '@coordinator', roles: ['coordinator'] }`.
- `archived`: no new routing; stays visible in history.
- `deleted`: soft-delete for privacy/admin removal; no routing/lookup/autocomplete; history keeps actor
  ID with redacted display metadata.
- Worker actors are identity-scoped by `(workflowRunId, nodeId, agentName)`. `nodeId` alone is not enough:
  one workflow node can host multiple agent slots with independent inbox, retry, and delivery state.
- Worker aliases like `@coder` and `@review` are contextual only. Do not register them as global Space
  handles. Globally addressable workers use exact worker-slot addresses such as `@worker:<run>/<node>/<agent>`.
- Worker address syntax uses `/` as a delimiter between `<run>`, `<node>`, and `<agent>`. v1 assumes node
  and agent names do not contain `/`. If a future workflow uses `/` in names, an escaping rule (e.g.
  percent-encoding) or ID-based fallback must be added; for now this is a validation constraint, not a
  runtime concern.

### Address syntax

Keep v1 syntax small:

| Syntax | Meaning | Example |
| --- | --- | --- |
| `@handle` | Actor handle in current Space | `@coordinator`, `@task-manager` |
| `@role:<role>` | Role binding in current Space | `@role:task-manager` |
| `@session:<id>` | Space session actor | `@session:abc123` |
| `@worker:<node>` | Worker node in current workflow context; valid only when node has one agent slot or caller context selects the slot | `@worker:Review` |
| `@worker:<node>/<agent>` | Exact worker slot in current workflow context | `@worker:Review/reviewer` |
| `@worker:<run>/<node>/<agent>` | Exact worker slot in explicit workflow run | `@worker:f1089/Review/reviewer` |
| `#<name>` | Optional channel/topic handle if enabled | `#deployments` |

Do not expose these as target syntax in v1:

- `session:<id>` — ambiguous with `@session:<id>`.
- `conversation:<id>` — too low-level for agents/users.
- `task:<id>` / `workflow:<id>` — context only, not deliverable targets.

If a caller must continue an existing conversation, use fields, not target syntax:

```ts
send_message({
	target: '@session:abc123',
	conversationId: 'conv_789',
	body: 'Following up here',
});
```

### Conversation

Conversation = app-level grouping for related message records. It is not a deliverable actor, route, or
LLM context by itself.

Use `conversationId` to say: "store this message with the same visible conversation as earlier
messages." The actual delivery target remains an actor address such as `@session:<id>`, `@coordinator`,
`@role:task-manager`, or `@worker:<run>/<node>/<agent>`.

This layer sits above SDK sessions and `sdk_messages`:

```text
Conversation
  ├─ message records and delivery records
  ├─ participants / target actors
  └─ links to one or more agent sessions / sdk_messages
```

SDK sessions still own LLM runtime context and transcript state. A single conversation can span multiple
agent sessions over time — for example a human-visible task conversation that starts with Coordinator,
then routes to a worker, then returns to Coordinator. Those sessions do not automatically share LLM
context; summaries or selected messages must be explicitly injected when a runtime needs continuity.

Keep the boundary clear:

- `conversationId` groups app messages for UI/history/replies.
- `target` decides which actor receives the message.
- `targets` resolve to actors; SDK session links point to the actual LLM transcript.
- Task/workflow timelines can project selected messages from conversations, but they are not themselves
  LLM-visible chat targets.

### Context

v1 does not use a separate `MessageContext` type. Metadata that callers and wrappers already know —
`workflowRunId`, `nodeId`, `agentName`, `sessionId` — is either encoded in the target address, available
to the resolver from wrapper context, or derivable at query time. Only `spaceId` is hard-scoped to the
message record itself, and it is already a top-level `MessageRecord` field.

### Message

```ts
type MessageKind = 'message' | 'system';

type MessageAttachment = {
	id?: string;
	type: 'image' | 'file' | 'url';
	mimeType?: string;
	name?: string;
	url?: string;
	storageKey?: string;
};

type MessageRecord = {
	messageId: string;
	spaceId: string;
	senderActorId: string;
	targets: string[]; // raw target strings after wrapper translation
	body: string;
	kind: MessageKind;
	workflowRunId?: string; // workflow scope; resolver uses for worker alias/pending delivery
	taskId?: string; // task scope; UI timeline projection and audit
	conversationId?: string;
	replyToMessageId?: string;
	attachments?: MessageAttachment[];
	data?: Record<string, unknown>; // structured gate/vote/approval payload
	idempotencyKey?: string;
	createdAt: number;
};
```

`MessageKind` stays intentionally small: `message` for actor-authored communication, `system` for
runtime-generated audit/delivery records. Product semantics such as question, answer, blocked, handoff,
approval request/result belong in `data` and/or UI/runtime projections, not transport-level kinds.

`data` is required for compatibility with current `node-agent send_message({ data })`: gated channel
payloads are merged into gate state today and must keep working after cutover. `attachments` preserves
current human task messaging images/files instead of forcing a side channel. `idempotencyKey` is
persisted on the message, but dedupe is evaluated per resolved recipient target/delivery, not per sender
message. For legacy pending worker delivery this preserves the current
`(workflowRunId, targetAgentName, idempotencyKey)` behavior: retrying the same delivery suppresses a
pending duplicate for that recipient, while multicast/broadcast can still create legitimate deliveries to
other recipients using the same key.

`spaceId` is required on every message. v1 messaging is Space-scoped — standalone sessions outside a
Space continue using existing `sdk_messages` / SDK transcript patterns, not this messaging layer. If
future needs require messaging outside Spaces, `spaceId` becomes optional and a `scope` or `domain` field
generalizes it, but that is not designed now.

### Delivery

One message can create many deliveries.

```ts
type DeliveryState = 'queued' | 'delivered' | 'failed' | 'expired' | 'skipped';

type DeliveryRecord = {
	deliveryId: string;
	messageId: string;
	/** Present after resolution succeeds; absent for unresolved fallback/error audit rows. */
	targetActorId?: string;
	/** Raw or translated target this delivery represents, for audit and unresolved failures. */
	targetRef: string;
	state: DeliveryState;
	attemptCount: number;
	maxAttempts: number;
	/** Enqueue timestamp; used for deterministic FIFO drain order across restarts/migration. */
	createdAt: number;
	expiresAt?: number;
	lastError?: string;
	deliveredSessionId?: string;
	deliveredAt?: number;
};
```

`pending_agent_messages` migration:

**MessageRecord mapping** — each legacy row maps to one `MessageRecord`:

- `messageId`: generate deterministic ID from legacy row ID (e.g. `msg_legacy_<id>`).
- `spaceId`: copy from legacy row's workflow/task Space context.
- `senderActorId`: resolve from `sourceAgentName` using sender-kind logic — not all senders are workers.
  Known cases:
  - `'human'` → human actor (sender was a human via task message RPC).
  - `'coordinator'` or `'space-agent'` → agent actor with coordinator role.
  - `'task-agent'` → legacy; map to coordinator agent role for backward compatibility.
  - worker agent name (e.g. `'coder'`, `'reviewer'`) → worker actor scoped by
    `(workflowRunId, nodeId, agentName)` from the legacy row's run context. Legacy rows do not store
    sender `nodeId`, so when the same agent name exists on multiple nodes in the run, the sender cannot
    be unambiguously reconstructed. Disambiguation rule: when `sourceAgentName` matches worker slots on
    multiple nodes and no further context is available, pick the last match by node creation order
    (most recent execution) and mark the `senderActorId` nodeId as approximate. Do not assume sender
    and target are on different nodes — within-node worker messaging is valid. V1 audit uses sender
    kind + name + run for human-visible attribution, not exact node.
  Do not infer sender kind from `targetKind`. A `targetKind = 'node_agent'` row can have
  `sourceAgentName: 'human'` (human sends to worker), and a `targetKind = 'space_agent'` row can have
  a real worker source (worker escalates to Coordinator). Preserve original sender identity in both
  directions.
- `targets`: `[targetAgentName]` — preserve original target text. For `space_agent` rows, keep
  `'space-agent'` (not rewritten to `@coordinator`). The DeliveryRecord mapping handles actual routing
  to Coordinator or stored reply-session; the MessageRecord stores the original caller-specified target
  for audit/replay fidelity.
- `body`: copy from legacy `message` field.
- `kind`: `'message'`.
- `workflowRunId`: copy from legacy row.
- `taskId`: copy from legacy row if present.
- `data`: copy from legacy `data` field if present (gate payloads).
- `idempotencyKey`: copy from legacy row.
- `createdAt`: copy from legacy row's creation timestamp.

**DeliveryRecord mapping** — each legacy row maps to one or more deliveries:

- legacy `pending` → `queued`
- legacy `delivered` → `delivered`
- legacy `failed` → `failed`
- legacy `expired` → `expired`
- preserve attempts, max attempts, TTL, last error, delivered session ID
- fan-out: restricted to pending/queued rows only. Legacy rows store `targetAgentName` only. If the
  same agent name exists on multiple nodes in the run (allowed because uniqueness is only enforced
  within a node), one pending legacy row expands to one delivery row per matching
  `(workflowRunId, nodeId, agentName)` slot. Each expanded row gets its own delivery ID and independent
  retry state. Terminal rows (`delivered`/`failed`/`expired`) are not expanded — they represent single
  historical attempts with single-recipient fields like `deliveredSessionId` and must keep their
  original single-recipient history.
- `targetKind` branching: legacy rows with `targetKind = 'node_agent'` expand as worker-slot deliveries
  above. Legacy rows with `targetKind = 'space_agent'` route to Coordinator (`@coordinator`) or stored
  reply-session, matching current `flushPendingMessagesForSpaceAgent` behavior. Do not expand
  `space_agent` rows as worker slots.

## Resolution rules

Keep resolver deterministic:

1. Parse target string.
2. Apply current Space/domain context.
3. Resolve exact `@handle` among routable actors: `active` delivers immediately; `inactive` can create
   queued delivery if activation/retry policy exists; `archived`/`deleted` do not route.
4. Resolve `@role:<role>` using role binding. If multiple active actors share the role, deliver to all
   matching active actors (stable ordered fan-out). If the only role holders are inactive, create queued
   delivery for each inactive holder — preserves escalation/retry behavior when role holder restarts.
5. Resolve `@session:<id>` to session actor if session is user-facing/ad-hoc. Inactive sessions can
   create queued delivery if activation/retry policy exists.
6. Resolve `@worker:<node>` using `workflowRunId` from context plus current `agentName` context, or only
   if that node has one routable agent slot. If `workflowRunId` is missing (non-workflow caller such as
   Coordinator or session actor), require explicit run-qualified target `@worker:<run>/<node>/<agent>`
   instead. Inactive workers create queued delivery. Resolution must enforce channel topology permissions
   before delivery — direct worker addressing does not bypass declared workflow channel policy.
7. Resolve `@worker:<node>/<agent>` using `workflowRunId` from context. If `workflowRunId` is missing
   (non-workflow caller such as Coordinator or session actor), require explicit run-qualified target
   `@worker:<run>/<node>/<agent>` instead. Inactive workers create queued delivery. Resolution must
   enforce channel topology permissions before delivery — direct worker addressing does not bypass
   declared workflow channel policy.
8. Resolve `@worker:<run>/<node>/<agent>` if sender can access that run. Inactive workers create queued
   delivery. Resolution must enforce channel topology permissions before delivery.
9. Resolve optional `#<name>` channel/topic if enabled.
10. If target does not resolve, return an error. Do not silently fallback; typos and stale handles must
    not leak content to another actor.

Important seeding rule:

- Session actors only come from ad-hoc human/member sessions.
- Exclude `space_chat`, removed/legacy `space_task_agent`, and workflow sub-sessions.
- Coordinator uses the agent-role path; no new design should depend on built-in task-agent helper behavior.

## API shape

### `send_message`

```ts
type SendMessageInput = {
	target: string | string[];
	body: string;
	kind?: MessageKind;
	spaceId: string;
	workflowRunId?: string;
	taskId?: string;
	conversationId?: string;
	replyToMessageId?: string;
	attachments?: MessageAttachment[];
	data?: Record<string, unknown>;
	idempotencyKey?: string;
};

type SendMessageResult = {
	messageId: string;
	deliveries: DeliveryRecord[];
};
```

### Other v1 tools

Minimal set:

- `send_message`
- `resolve_address`
- `list_actors`
- `read_messages` / `read_conversation` if UI/agent needs history
- Defer `mark_handled` until delivery records grow read/handled timestamps; v1 keeps delivery state to queue/delivery outcomes.

Do not add a full conversation management API until product needs it.

## Compatibility wrappers

### `node-agent-tools.send_message`

Maps current workflow messaging into `send_message`:

```ts
const translatedTargets = translateLegacyNodeTargets(target, {
	spaceId,
	taskId,
	workflowRunId,
	nodeId,
	agentName,
});

send_message({
	target: translatedTargets,
	body: message,
	kind: messageKind ?? 'message',
	data,
	spaceId,
	workflowRunId,
	taskId,
});
```

Preserve:

- channel topology permissions
- gated channel payload merge from `data`
- queued delivery for inactive target sessions
- activation hooks
- broadcast, multicast array, reserved `space-agent`, node-name, and agent-name resolution where supported today

Legacy node targets must be translated before calling generic `send_message`:

| Legacy target | Generic target |
| --- | --- |
| `'*'` | expand before send to topology-permitted exact worker-slot targets `@worker:<run>/<node>/<agent>` |
| `string[]` multicast | translate each element independently with these rules, flatten, and de-dupe by recipient target |
| `space-agent` | reserved compatibility target; first check stored reply-session route `(taskId, agentName) → replyToSessionId` and deliver to `@session:<id>` if present, otherwise fall back to Coordinator (`@coordinator`) |
| `task-agent` | removed legacy target; reject explicitly or map only in temporary migration shims for old queued rows, never as a worker alias |
| bare agent name | expand to all `(nodeId, agentName)` matches across run topology (fan-out); each match becomes a separate `@worker:<run>/<node>/<agent>` delivery |
| bare node name | expand to all agent slots in that node (fan-out); each slot becomes a separate `@worker:<run>/<node>/<agent>` delivery |
| already generic `@...` / `#...` | pass through |

### Task message compatibility wrapper

Preserve current post-task-agent behavior:

- Task/workflow IDs remain context, not message targets.
- `node_id` is required for node/worker-targeted sends, matching current `send_message_to_task` API
  contract. No implicit task-only fallback routing; calls without a target node or actor fail fast.
- `node_id` maps to worker target: if `node_id` is a UUID, look up the workflow node execution by that
  UUID to find `(workflowRunId, nodeId, agentName)`, then format `@worker:<run>/<node>/<agent>`. The
  `<node>` component must be the workflow node **name** (not internal node execution ID), because
  channel topology permissions are node-name based (`WorkflowChannel.from/to`,
  `ChannelResolver.canSend(fromNode,toNode)`). Convert execution `workflowNodeId` to node name via
  workflow definition lookup before formatting the address. If `node_id` is not a UUID, resolve by
  agent name to a single match using workflow topology (matching current `resolveNodeExecution` helper:
  UUID first, then last agentName match by ascending creation order — i.e. most recent execution).
  This resolves to exactly one worker slot, not fan-out — even if the agent name appears on multiple
  nodes, the wrapper picks the most recent match. Fan-out only applies to the legacy node-agent
  `send_message` wrapper's bare agent/node name targets, not to `send_message_to_task`.
- Wrapper input accepts an optional `target` field for explicit actor/role/session targets
  (`@coordinator`, `@role:task-manager`, `@session:<id>`). When `target` is set, it takes precedence
  over `node_id` and is mapped directly to generic `send_message.target`.
- Reject removed legacy `task-agent` targets for new calls; keep only narrow migration handling for old
  queued rows if storage still contains them.
- Mark wrapper deprecated after generic tool adoption.

### Human task message RPC

Routes to explicit worker/role/session when mentioned; requires same target specification as task message
compatibility wrapper. Maps existing image/file payloads into `send_message.attachments` explicitly:
each image becomes a `MessageAttachment` with `type: 'image'`, preserving current multimodal task
messaging behavior.

## Package / implementation shape

Recommended split:

```text
packages/messaging/                 # or daemon-internal equivalent first
  src/types.ts                       # ActorRef, MessageRecord, DeliveryRecord
  src/address.ts                     # parse/format target strings
  src/contracts.ts                   # resolver/router/storage interfaces

packages/daemon/src/lib/space/
  messaging-adapter.ts               # Space actor resolver + policy + delivery executor
  tools/*                            # MCP wrappers call generic service
  runtime/*                          # workflow activation/gates remain here
```

Do not move SQLite schema or runtime activation into generic package. Generic package should define
contracts and pure helpers; daemon owns persistence/execution.

## Future extension points

### Inter-Space

Do not implement now. Future adapter can wrap the same message shape in a remote envelope:

```ts
type RemoteEnvelope = {
	originSpaceId: string;
	targetSpaceId: string;
	originActorId: string;
	target: string;
	message: MessageRecord;
	trustLevel: 'local' | 'same_org' | 'external';
	correlationId: string;
};
```

Future syntax can be added without changing core records:

- `space:<spaceId>::@handle`
- `space:<spaceId>::@role:<role>`
- `space:<spaceId>::#channel`

Until adapter exists, reject these explicitly. Never fallback to local handles.

### Inter-domain

Same model, different adapter. Examples:

- GitHub issue/PR comment actor
- Slack user/channel
- support ticket thread
- external automation bot

Future syntax:

- `domain:github::@release-bot`
- `domain:github::conversation:pr-1920`

Domain adapter owns identity proof, permission, rate limits, and external audit mapping.

### Task timeline and workflow execution log

Task/workflow are not chat targets. Future UI may add projections:

- **Task timeline**: human-readable task feed of decisions, questions, answers, artifacts, and status.
- **Workflow execution log**: runtime feed of node handoffs, gate writes, queued delivery, retries, CI,
  artifacts, and system events.

These surfaces reference messages/events. They do not own reply routing and are not injected wholesale
into LLM context.

## Migration plan

1. Add generic messaging types/address parser/contracts.
2. Seed minimal actor registry:
   - Human actors from Space membership/users.
   - Coordinator from current Space Agent / `space_chat` default session.
   - Session actors from ad-hoc human/member sessions only.
   - Agent actors for long-term agents when they exist.
   - Worker actors from active and declared workflow node executions, including inactive workers
     referenced by pending rows.
   - System actors for runtime subsystems.
3. Implement Space adapter resolver and delivery writer.
4. Map `pending_agent_messages` into delivery rows/facade.
5. Wrap `node-agent send_message` and preserve gate `data` behavior.
6. Wrap current task message RPC/tooling and require explicit target (node ID, actor, or role).
7. Update Space MCP attachment by explicit actor/session role:
   - `space_chat` / Coordinator gets generic messaging + management.
   - ad-hoc Space sessions get generic messaging.
   - workflow workers get generic messaging through node wrapper.
   - removed/legacy `space_task_agent` sessions are excluded; no new attachment path depends on them.
8. Keep only narrow migration handling for old task-agent queued rows if present; do not design new flows
   around the removed helper.

## Follow-up implementation tasks

1. **Add generic messaging contracts and address parser**
   - Minimal types, parser, resolver/router/storage interfaces.

2. **Add Space actor registry adapter**
   - Depends on task 1.
   - Seed Coordinator, Human, Session, Worker, System actors using current data.

3. **Implement Space resolver and delivery facade**
   - Depends on tasks 1 and 2.
   - Preserve current workflow routing and pending delivery semantics.

4. **Wrap existing MCP/RPC tools**
   - Depends on task 3.
   - `node-agent send_message`, current task message RPC/tooling, human task message RPC.

5. **Add long-term agent inbox / DM activation**
   - Depends on task 4.
   - Enables agent ↔ agent and session ↔ agent messaging.

6. **Refactor Space MCP attachment by actor/session role**
   - Depends on task 4.
   - Replace broad `context.spaceId` sweeps and skip guards with explicit policy.

7. **Add UI projections**
   - Depends on tasks 3 and 4.
   - Actor labels, target resolution badges, delivery state, task timeline projection.

Dependency graph:

```mermaid
flowchart TD
	T1[1 contracts + parser] --> T2[2 Space actor registry]
	T1 --> T3[3 resolver + delivery]
	T2 --> T3
	T3 --> T4[4 wrappers]
	T4 --> T5[5 long-term inbox]
	T4 --> T6[6 MCP attachment policy]
	T3 --> T7[7 UI projections]
	T4 --> T7
```

## Updates to draft tasks

### #398 — Untangle Space MCP ownership by session role

Keep, but scope it after generic messaging wrapper work. Replace current skip mechanisms with explicit
actor/session-role policy:

- `session.type === 'space_chat'`
- removed/legacy `session.type === 'space_task_agent'` if older databases or sessions still contain it
- workflow sub-session ID checks using `:task:` + `:exec:`

Do not treat `:agent:` as a guard; it is session ID construction.

### #399 — Fix Space ad-hoc session MCP reattach after daemon restart

If urgent, keep tactical fix now. Long-term fix becomes role-based attachment using actor/session
policy.

### #400 — Remove built-in task-agent LLM helper from Space workflows

Superseded by current `dev`: built-in task-agent helper has already been removed. Update remaining work:

- keep generic messaging wrappers aligned with current task message RPC/tooling
- require explicit target for task message sends (node ID, actor, or role)
- preserve pending delivery migration for any old queued rows still present in existing databases
- reject removed `task-agent` targets for new sends except narrow migration shims
- ensure no new MCP attachment or workflow plan depends on `space_task_agent`

No new work should reintroduce the built-in task-agent helper.
