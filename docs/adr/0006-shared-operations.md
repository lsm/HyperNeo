# ADR 0006: Shared Operations Across RPC and MCP

## Status

Accepted — 2026-09-11. Tracks epic #4164 (unify Space task operations). This
ADR records the implemented operation seam, the per-transport pre-invocation
pipeline design it grows into, and how it relates to the ADR 0005 action
dispatcher. Snapshot at acceptance: shared start/retry (#4382, PR #4391) is
under review; the guardian runtime (PR #4367) is parked and is not a
prerequisite for the first release. Do not describe the stream as complete
until its final merge gates pass.

## Context

Task behavior reached the daemon through three doors, each with its own
implementation: MessageHub RPC handlers for the UI, typed MCP tools for agents
(`space-agent-tools.ts` and its role variants), and internal callers inside the
Space runtime. A status transition, a review submission, or a cancellation could
validate differently, write differently, and emit different events depending on
which door it entered. Agent-only names such as `agentActions` described
functionality humans also used.

ADR 0005 addressed the *agent-facing* half of the problem: one `call_action`
choke point on the `space-actions` server owning safety classes, autonomy
admission, audit, telemetry, and per-role descriptions. It deliberately does
not route through MessageHub and does not define an RPC surface. It left the
underlying duplication in place — the actions wrap the existing typed handlers,
and the RPC handlers still own their own copies of the rules.

This ADR defines the *domain* half: one transport-neutral operation per
business path, called by RPC, MCP, and internal code alike, fed by one
pre-invocation pipeline per transport that turns a raw call into a trusted
caller principal. The two ADRs are layers, not competitors; decision 4 fixes
their relationship.

## Decision

### 1. Define the operation once

The unit of reuse is a domain operation, not a human handler or an agent tool.
Each operation has a stable dotted name (`task.update`, `task.submitForReview`,
`task.cancel`), a description of its actual behavior and supported scope, a Zod
input schema, a Zod result schema, and one `execute(input, caller)` function
that receives validated input and a trusted caller principal.

```ts
interface OperationCaller {
  source: 'rpc' | 'mcp' | 'internal';
  sessionId?: string;
}

interface OperationEntry<Input, Output> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  resultSchema: z.ZodType<Output>;
  execute(input: Input, caller: OperationCaller): Promise<Output>;
}
```

`OperationCaller` is the principal, and it grows as the pre-invocation
pipelines (decision 3) resolve more about the caller: Space membership, role,
effective autonomy level, user identity. It never grows by an operation
inferring those facts from input.

Naming: no `space` prefix when Space is an ownership or execution context
rather than the identity of the operation. A generic name does not imply
universal support — the description states which task types and ownership
modes the current binding admits (`task.cancel` handles one running direct
task; workflow tasks and dependent cascades stay on their existing routes).

```text
Human/UI --> RPC adapter --> RPC pre-invocation pipeline ------+
             (envelope)      resolve human principal           |
                             RPC-specific policy stages        |
                                                               |
Agent -----> MCP adapter --> MCP pre-invocation pipeline ------+--> shared invoker
             (tool args)     session -> agent principal        |    resolve operation
                             Space membership, role, autonomy  |    validate input
                             MCP-specific policy stages        |    execute
                                                               |    validate result
Internal --> internal principal -------------------------------+
                                                               |
        shared stages, exported and composed by any pre-invocation pipeline:
        authenticate, resolve target scope, require scope match, audit
                                                               |
                                                               v
                              one direct superpipe pipeline per operation
                              execution-ownership admission + decisions + effects
                                                               |
                                                               v
                                        repositories / managers / jobs
```

### 2. Transport adapters stay thin

RPC and MCP invoke the same registry entry through the same invoker
(`invokeOperation`: resolve → parse input → execute → validate result, a single
`result:invocation` gate cascade). Adapters own only transport concerns:
envelope parsing, handing the raw call to the transport's pre-invocation
pipeline, response formatting, and protocol error mapping
(`unknown_operation` → `METHOD_NOT_FOUND`, `invalid_input` → `INVALID_PARAMS`,
everything else → `HANDLER_ERROR` for RPC; `isError` content with the code for
MCP). An adapter never implements a second transition, retry policy, mutation,
or event sequence, and never implements policy inline.

`operations.list` and `operations.describe` derive summaries and JSON schemas
from the registry at runtime. Discovery is a catalog read, not authorization,
and it must not open sessions, touch a half-configured database, or execute
task work.

### 3. Caller principal and per-transport pre-invocation pipelines

Every call passes through exactly one **pre-invocation pipeline** owned by its
transport before it reaches the shared invoker. The pipeline is a direct
superpipe composition (ADR 0004) whose output is either a trusted
`OperationCaller` or a transport-level rejection. It is where the transports
legitimately differ:

- **RPC pipeline.** Parses the MessageHub envelope and resolves the human
  principal. Today that principal is `{ source: 'rpc' }` — the daemon is
  single-user and every other RPC handler is equally anonymous. When user
  identity or session-bound authentication arrives it is a stage here, and the
  principal gains a user field.
- **MCP pipeline.** Binds the call to the owning `AgentSession` and resolves
  the agent principal from persisted state: session id and type, the Space the
  session belongs to, its role, its effective autonomy level. MCP-specific
  policy stages compose after that — for example, a Space agent may act only on
  tasks in its own Space, or below its autonomy ceiling.
- **Internal callers** construct the principal directly with
  `source: 'internal'`; they are trusted code, not a transport.

**Shared stages** are exported stage functions that any pre-invocation
pipeline composes: authenticate a session, resolve the target scope of a call
(load the task named in the input and read its Space), require the caller's
scope to match the target's, write an audit row. RPC and MCP compose the same
`requireSameSpace` stage with different principals; neither transport gets a
private copy of the rule. Input-shape validation is already shared — it lives
in the invoker.

Two kinds of admission, in two places:

| Admission | Question | Lives in |
| --- | --- | --- |
| Principal admission | Who is calling, from which Space or role, against which target? | Transport pre-invocation pipeline and the shared stages it composes |
| Execution-ownership admission | Is this the persisted worker of this attempt, at this generation, with the current task pointer? | Named stage inside the operation (`admitSubmission`, `admitCancellation`) |

Execution ownership stays inside the operation because it is an invariant of
the effect, not a policy: the effect is unsafe without it whoever calls.
Principal admission stays outside because it changes per transport and per
deployment without changing what the operation does.

Rules that follow:

- `OperationCaller` is produced only by a pre-invocation pipeline. Operations
  never accept a caller-supplied session id, attempt id, generation, or
  ownership token as proof of authority; when they need ownership facts they
  load the persisted task, session, and active attempt and compare against the
  principal.
- Operations read principal facts from `OperationCaller` and never branch on
  `source` to substitute for a missing fact. Three operations today carry a
  `caller.source === 'mcp'` branch that re-derives Space membership from the
  session row because the principal is still too thin. That is transitional
  debt: as the MCP pipeline resolves those facts, the branches collapse to
  reading them.
- Today's adapters take a `resolveCaller` callback. That callback is the
  degenerate one-stage form of the pre-invocation pipeline, and the seam where
  the pipeline slots in. Extending caller policy means replacing the callback
  with a pipeline, not teaching operations about transports.
- A pre-invocation rejection is a result value with its own reason family
  (decision 5), surfaced through the adapter's normal error mapping.

### 4. Layering with the ADR 0005 action dispatcher

Operations are the **domain layer**; the pre-invocation pipelines and the ADR
0005 dispatcher are **policy layers**. The relationship:

- The MCP pre-invocation pipeline is the `invoke` counterpart of
  `dispatchAction`: both stand between an agent and an effect and both own
  agent policy. They share stages rather than rules — safety class, autonomy
  admission (`resolveEffectiveAutonomyLevel`, `decideAutonomyAdmission`), audit
  and telemetry writes are exported stages composed by both, never
  reimplemented on either side.
- A `call_action` entry that mutates task state delegates to the operation
  rather than to a typed handler, so there is one implementation. A named tool
  wraps a definition instead of owning its business logic (decision 1); a
  `call_action` entry is a named tool. No action delegates yet (see Current
  state); migrating them is ordinary wire work under this ADR.
- The generic `invoke` tool on the `hyperneo-operations` server is attached to
  every agent session. Until the MCP pre-invocation pipeline resolves Space
  membership and role, it carries only operations whose admission is execution
  ownership — a worker submitting its own outcome, a session editing a task it
  is bound to. Operations that need Space policy to be safe reach agents
  through `call_action` for now. Once the MCP pipeline composes the shared
  policy stages, that restriction lifts by construction.
- MessageHub RPC reaches operations through `operation.invoke`. ADR 0005's ban
  on RPC loopback stands: the dispatcher is not reachable over RPC, and RPC
  callers get the human policy from the RPC pipeline, not the agent policy.
- Whether `call_action` eventually becomes a thin front over the MCP
  pre-invocation pipeline or stays a parallel front is open. Both are
  compatible with this ADR because policy lives in shared stages, not in a
  transport or an operation.

### 5. Result contract

- **Domain rejections are result values.** An operation that declines returns
  `{ accepted: false, reason }` (or the equivalent arm of its result union)
  and the invoker reports `completed`. Throwing is reserved for infrastructure
  faults; the invoker maps any throw to `execution_failed` with the message
  only, so a thrown rejection loses its type and looks like a bug.
- **Reason families are distinct.** A rejection names *why* in a way the
  caller can act on: the binding does not support this task or state
  (`*_unavailable`), the caller is not admitted (`*_denied`), or the
  pre-invocation pipeline refused the call before it reached the operation
  (`*_unauthorized`, `*_out_of_scope`). Agents retry the first after changing
  state and the others never. Existing reasons that predate this rule
  (`direct_cancellation_unavailable` covers unsupported and denied) are split
  as their operations are next touched.
- **Immediate result or durable acknowledgement — say which.** A schema and
  description state whether the value is a completed synchronous result or an
  acknowledgement of accepted background work (decision 8).
- **Result validation is not optional.** `invalid_result` is a real failure
  code; an operation whose execute returns something its schema rejects fails
  the call rather than leaking an untyped value.

### 6. One direct pipeline per operation

Per ADR 0004: each operation composes as one superpipe pipeline named for the
business operation, mixing pure decisions, transforms, and effects. Typed
rejection gates return disjoint `{ value }` / `{ reason }` arms and every gate
in the path targets the same `result:<name>` output so an early exit is the
final result. Reuse exported stages directly (`enqueueDirectOutcome` is one
stage shared by `task.submitForReview` and `task.cancel`); do not nest
pipelines that hide their effects. The same rule governs the pre-invocation
pipelines and their shared stages.

Transactions, process handles, locks, and resource-owning loops stay ordinary
owners and consult pipelines at their decision points (the decide-owning
hybrid). Superpipe does not own atomicity or lifetime.

### 7. Instance-owned composition

Registries are instances, never module singletons. Operation factories receive
named dependencies (`TaskOperationDependencies`), not positional lists.
`SessionManager.getOperationRegistry()` resolves custom provider → default
provider → database catalog, and the Space provider memoizes one configured
registry per daemon. Pre-invocation pipelines are built the same way: the
composition layer supplies the session, Space, and policy dependencies their
stages need. `app.ts` and RPC setup assemble capabilities; domain decisions
live in operations, policy decisions in pipeline stages, never in registration
code.

### 8. Domain state versus execution mechanism

A task has its own lifecycle. A Space may own it and a workflow may execute
it; neither relationship makes a workflow mandatory for every operation.
Workflow run/node behavior sits behind explicit execution dependencies;
direct-session execution reuses the task rules and prompts without fabricating
a run. SDK idle is not task completion — completion and review submission are
explicit operations.

Long-running or self-interrupting actions return **durable acknowledgements**:

1. Admit and freeze the canonical request.
2. Persist request, state/ownership change, and job linkage in one transaction
   (`enqueueDirectOutcome` runs in an `immediate` transaction and returns the
   existing receipt on replay).
3. Return `{ accepted: true, jobId }`.
4. A registered job worker performs session preparation, delivery, or shutdown.
5. Commit the lifecycle transition under its ownership guards.

A worker submitting its own outcome never awaits its own interruption inside
the MCP call. A start acknowledgement means queued work, not a running SDK
session. Message acceptance means durable mailbox persistence, not an agent
reply. Ordinary request/response association is separate from later agent
messages and events; there is no conversation-wide correlation scheme.

### 9. Invariants across asynchronous boundaries

- Freeze inputs, including rejection feedback, at admission. Replay reads the
  frozen request; nothing rebuilds it from mutable task metadata later.
- Stable request identities plus persisted receipts make replay idempotent:
  the same request returns the same `jobId`.
- Temporary waiting (paused Space, unmet dependency, occupied capacity) defers
  a claim-fenced job without consuming its failure budget. Terminal or
  superseded requests settle explicitly and clean up; they never loop.
- Capture lifecycle generations at admission and revalidate at the mutation or
  activation boundary after every await. Cancel-then-reopen must not revive an
  old accepted request because the status text matches again.
- Capacity checks are atomic with reservation and shared by every competing
  execution path. A limit checked before an asynchronous spawn reserves nothing.
- Never weaken shutdown proof to make a retry pass. Missing cached process
  state is not evidence that an old worker exited.

## Module layout

| Module | File | Responsibility |
| --- | --- | --- |
| Contract | `packages/daemon/src/lib/operations/registry.ts` | `OperationEntry`, `OperationCaller`, registry, provider precedence |
| Invoker | `packages/daemon/src/lib/operations/invoke.ts` | resolve → validate → execute → validate result |
| RPC adapter | `packages/daemon/src/lib/operations/rpc-adapter.ts` | `operation.invoke` handler, `resolveCaller` seam, error-code mapping |
| MCP adapter/server | `packages/daemon/src/lib/operations/mcp-adapter.ts`, `mcp-server.ts` | `invoke` tool on the `hyperneo-operations` server, `resolveCaller` seam |
| Discovery | `packages/daemon/src/lib/operations/discovery.ts` | `operations.list`, `operations.describe` |
| Common catalog | `packages/daemon/src/lib/operations/catalog.ts`, `database-catalog.ts` | `message.send`, `task.get/create/list/update/transition`, `task.dependencies.set` |
| Space catalog | `packages/daemon/src/lib/space/operations/registry.ts` | adds `task.submitForReview`, `task.cancel`, `task.resolvePendingCompletion`, Space-aware metadata/dependency editors |
| Shared operation example | `packages/daemon/src/lib/space/operations/submit-for-review.ts` | execution-ownership admission + durable acknowledgement |
| Durable outcome | `packages/daemon/src/lib/space/runtime/direct-outcome-jobs.ts` | receipt, enqueue, verified finalization |
| Durable start | `packages/daemon/src/lib/space/runtime/direct-start-jobs.ts` | claim, linked job, superseded-claim guard |
| RPC wiring | `packages/daemon/src/lib/rpc-handlers/operation-handlers.ts`, `index.ts` | registers `operation.invoke` with the Space registry provider |
| MCP wiring | `packages/daemon/src/lib/agent/agent-session.ts`, `query-options-builder.ts` | attaches the server to every agent session |
| Pre-invocation pipelines | not yet built | one per transport; shared stages alongside them |
| Reusable policy stages | `packages/daemon/src/lib/space/tools/tool-admission-gates.ts`, `space/actions/safety.ts` | autonomy and safety stages the pipelines compose |

## Current state

What is wired versus what the design permits. Read this before assuming
parity.

| Path | State |
| --- | --- |
| Registry, invoker, both adapters, discovery, instance-owned catalogs | Implemented and tested (`tests/unit/1-core/operations/`, `2-handlers/rpc-handlers/operation-handlers.test.ts`, `5-space/runtime/{submit-for-review,cancel-task,direct-outcome-jobs,direct-start-jobs,operation-registry}.test.ts`) |
| Shared metadata, dependencies, review submission, approval/rejection, direct cancellation | Implemented; supported ownership types vary per binding — read the description |
| `task.start` / verified retry | Pending in PR #4391 (#4382) |
| Caller policy | `source` is the only differentiation. Neither adapter authenticates or authorizes: the RPC adapter resolves `{}`, the MCP adapter resolves the owning session id. Cross-Space and role checks exist only inside three operations' admission stages |
| Pre-invocation pipelines | **Not built.** The `resolveCaller` callbacks are the seam |
| Web UI | **Zero callers** of `operation.invoke`. The UI still uses legacy RPC handlers; the human arrow in the diagram is a capability, not a fact |
| `call_action` → operations | **No action delegates to an operation yet**; actions still wrap typed handlers |
| Legacy typed MCP tools and RPC handlers | Not all removed or migrated; each family follows the procedure below |
| Daemon-crash recovery | An outcome job whose shutdown cannot be verified parks and requeues every 30 s (`parked: 'direct_stop_unverified'`). After a daemon restart there is no in-memory process handle to verify against, so such jobs stay parked until the guardian ledger (PR #4367) lands. This is a known boundary, not an accident |

## Migration procedure per action family

Use the CLAUDE.md slice ladder (pin → extract → build → wire → delete) with one
addition at the front:

0. **Inventory** RPC, MCP, and internal callers and their observable behavior:
   validation, scope, writes, events, audit, callbacks, timing.
1. Pin behavior that must survive; do not enshrine code scheduled for deletion.
2. Extract shared policy and field-preparation functions with zero behavior
   change.
3. Build one operation from those rules with explicit effect dependencies.
4. Wire callers through it, keeping transport formatting and compatibility.
5. Delete obsolete wrappers only after every caller has moved.

Name behavior changes explicitly in the description. A legacy cancellation
that cascades to dependents and a new operation that cancels one task are not
interchangeable wrappers. If rejection now queues a fresh worker in `open`, the
description must not promise immediate `in_progress` execution.

Each merge is a usable checkpoint: register consumers before exposing
producers. Branch from merged `dev`; never stack on an unmerged sibling.

## Validation

CI coverage for an operation includes: RPC/MCP semantic parity, caller scope,
invalid input and invalid result, idempotent replay, exactly-once effects,
transaction rollback, stale claims, lifecycle changes during awaits, temporary
waiting versus terminal settlement, and one connected start → review →
approval flow. A pre-invocation pipeline is tested per stage and per gate like
any other pipeline: principal resolution from persisted state, each policy
stage's accept and reject arms, and that a rejection never reaches `execute`.
Validate observable results and effects; do not couple tests to private
methods or fixtures that violate real workflow or schema rules. Cover the
failure and concurrency windows of the changed path without expanding into
unrelated recovery infrastructure.

## Where operations must not be used

- **As the home of caller policy.** Who may call, from which Space or role,
  against which target, belongs to the transport pre-invocation pipelines and
  the shared stages they compose. An operation's own admission is limited to
  execution-ownership facts; an operation that starts checking autonomy or
  branching on `source` is in the wrong layer.
- **As an owner of atomicity or lifetime.** Effects write through repository
  primitives and transactions; the pipeline consults them, it does not become
  them.
- **On hot inner loops.** Per-event or per-token paths call functions
  directly.
- **As a correlation or conversation scheme.** Request/response association
  ends at the acknowledgement.
- **To resurrect a workflow requirement.** Direct execution must not fabricate
  a run to satisfy workflow-shaped dependencies.
- **Before its description is honest.** An operation whose description
  overstates supported task types or promises immediate execution for queued
  work is not ready to register.

## Open items

- Build the MCP pre-invocation pipeline: resolve session → Space membership,
  role, and effective autonomy into `OperationCaller`; replace the MCP
  adapter's `resolveCaller` callback with it.
- Build the RPC pre-invocation pipeline as its one-stage anonymous form now, so
  the seam exists before user identity does.
- First shared policy stage (`requireSameSpace`), composed by the MCP pipeline;
  migrate the three existing `caller.source === 'mcp'` branches onto principal
  fields.
- Split legacy `*_unavailable` reasons into unavailable/denied families as each
  operation is touched; define the pre-invocation reason family with the first
  pipeline.
- First `call_action` entry delegating to an operation (`task.cancel` is the
  natural candidate: identical semantics, different policy layer).
- First UI control calling `operation.invoke`, under a characterization pin of
  its legacy handler.
- Decide the eventual relationship between `call_action` and the MCP
  pre-invocation pipeline (thin front versus parallel front).
- Guardian-based daemon-crash recovery (PR #4367), separately scoped.

## References

- Epic #4164; issue #4382; PR #4391 (shared start/retry); PR #4367 (guardian,
  parked)
- Landed slices: #4162, #4167, #4214, #4217, #4222, #4239, #4250, #4251,
  #4265, #4273–#4381 (direct execution ledger, durable outcome and start jobs,
  shared review submission, cancellation, rejection routing)
- ADR 0004: `docs/adr/0004-superpipe-pipelines.md`
- ADR 0005: `docs/adr/0005-capability-dispatcher.md`
- Action dispatcher: `packages/daemon/src/lib/space/actions/`
- Admission gates: `packages/daemon/src/lib/space/tools/tool-admission-gates.ts`
- Typed surface: `packages/daemon/src/lib/space/tools/space-agent-tools.ts`
