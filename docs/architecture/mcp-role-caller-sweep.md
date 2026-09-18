# MCP role-caller sweep of the operations door

Answers #4727: after #4726 (`57723b053`) made `isOperationAdmitted`
(`packages/daemon/src/lib/operations/invoke.ts`) return `true` unconditionally, which
operations does an MCP caller in each `OperationCallerRole` newly reach, and does anything
still stand behind the door for them?

Measured against `origin/dev` @ `57723b053` (2026-09-18), the commit that merged #4726.

## Method

`isOperationAdmitted`'s removed logic did three things for `source: 'mcp'` callers only:
deny `safetyClass: 'human_only'` outright, deny a role not in `policy.roles` when the policy
declared one, and deny `universal_read` on anything but a `read` policy. RPC and internal
callers were always exempt (`if (caller.source !== 'mcp') return true` predates #4726), so the
RPC smoke run behind #4726 is not evidence either way — that matches the issue's framing.

For each operation that declares a `roles` list, I read every call site of the function that
builds it (`create*Operation`) to find the pipeline stage that runs before `execute`, then
traced that stage's admission function to see whether it re-checks `caller.role` on its own,
independent of the door. Where one exists, I ran the project's own existing unit tests for
that operation family — they already construct `OperationCaller` objects with `source: 'mcp'`
and a specific role and drive them through `invokeOperation`/`operation.execute` exactly as
the issue asks, using the real production `create*Operation` factories, not a mock registry.
That is more reliable than hand-rolling a scratch harness for 89 operations with 89 sets of
fake dependencies, and it is the same technique #4726 itself used to update its 25 touched
test files. All of the following passed on `57723b053` as run for this sweep:

```
tests/unit/1-core/operations/invoke-admission.test.ts
tests/unit/1-core/operations/discovery.test.ts
tests/unit/1-core/audit/audit-list-operation.test.ts
tests/unit/5-space/agent/agent-read-operations.test.ts
tests/unit/5-space/agent/agent-reminder-operations.test.ts
tests/unit/5-space/agent/agent-template-operations.test.ts
tests/unit/5-space/agent/assign-agent-operation.test.ts
tests/unit/5-space/agent/create-agent-operation.test.ts
tests/unit/5-space/agent/update-agent-operation.test.ts
tests/unit/5-space/evolution/forge-scope-operations.test.ts
tests/unit/5-space/evolution/forge-episode-operations.test.ts
tests/unit/5-space/goals/create-goal-operation.test.ts
tests/unit/5-space/goals/goal-child-listing-operations.test.ts
tests/unit/5-space/goals/goal-read-operations.test.ts
tests/unit/5-space/goals/goal-state-write-operations.test.ts
tests/unit/5-space/goals/review-goal-outcome-operation.test.ts
tests/unit/5-space/operations/retry-task-operation.test.ts
tests/unit/5-space/other/node-messaging-topology-reads.test.ts
tests/unit/5-space/other/node-peers-list.test.ts
tests/unit/5-space/other/node-send-message-operation.test.ts
tests/unit/5-space/other/schedule-operations.test.ts
tests/unit/5-space/other/session-operations.test.ts
tests/unit/5-space/workflow/workflow-read-operations.test.ts
tests/unit/5-space/workflow/workflow-run-operations.test.ts
tests/unit/5-space/operations/artifact-operations.test.ts
tests/unit/5-space/operations/inactivity-operations.test.ts
tests/unit/5-space/operations/node-agent-restore.test.ts
tests/unit/5-space/operations/subscription-operations.test.ts
tests/unit/5-space/operations/agent-subscription-operations.test.ts
```

Where a family had no such test exercising a denied role, I did not assume it was covered —
see **What this method could not verify** below.

## Correction to the issue's premise: it's not ~25, it's 89

Counting every `defineOperation({...})` call site with a `policy.roles` array (not just the
ones the issue happened to sample), **89 of the 108 registered operations declare a roles
list**, not "roughly 25." The 25 figure in the issue undercounts the surface, and the
count of test files #4726 touched is not a proxy for it either way: `57723b053`'s test churn
was broad, not narrow. `git show 57723b053 -- 'packages/daemon/tests/**'` removes 55 lines
naming the door or `code: 'forbidden'` across 23 test files, spanning the agent, goal,
workflow, node, schedule, session, forge, audit and `task.retry` families — so "which
families had door-asserting tests" is not a useful axis to reason on. Most of them did. What
the test churn measures is where an assertion happened to name the door in its wording, which
is a property of how each test was written, not of which operations declare `roles`. The
roles count below is taken from the `defineOperation` call sites directly.

Counts by family (`packages/shared/src/types/operation-names/*.ts`):

| Family | Total ops | Declare `roles` | Gate function (family-owned, independent of the door) | Denial shape |
|---|---|---|---|---|
| agent | 17 | 17 | `admitAgentCaller` (`agents/operation-contracts.ts`) | `{ rejected: true, reason: 'agent_denied' }` |
| goal | 11 | 11 | `admitGoalRole` / `admitGoalSpace` / `admitGoalAccess` (`goals/goal-operation-scope.ts`) | `{ accepted: false, reason: 'role_denied' }` |
| forge (evolution) | 23 | 23 | `admitForgeReader` / `admitForgeMutator` (`evolution/forge-admission.ts`) | `{ accepted: false, reason: 'forge_denied' }` |
| workflow | 5 | 5 | `admitWorkflowScope` (`workflows/workflow-operation-admission.ts`) | `'caller_not_admitted'` |
| schedule | 6 | 6 | `admitSpaceCaller` (`operations/space-caller-admission.ts`) | `{ ok: false, reason: 'denied' }` |
| session | 6 | 5* | `admitSpaceCaller` | `{ ok: false, reason: 'denied' }` |
| audit | 1 | 1 | `admitSpaceCaller` | `{ ok: false, reason: 'denied' }` |
| node + `send_message` (messaging) | 4 | 4 | `admitNodeCaller` (`messaging/node-messaging-context.ts`) | `'node_caller_denied'` |
| artifacts | 2 | 2 | `admitArtifactCaller` (`artifacts/artifact-operations.ts`) | `'node_caller_denied'` |
| task (`task.retry` only) | 16 | 1 | `admitRetrier` (`tasks/retry-task.ts`) | `'retry_denied'` |
| externalEvent | 14 | 14 | `admitEventCallerSpace` (`external-events/operation-admission.ts`) | `{ reason: 'caller_denied' }` |
| core (`operations.list/describe`) | 2 | 0 | n/a — see Discovery below | — |
| `message.send` (messaging) | 1 | 0 | n/a — policy-free, see below | — |
| **Total** | **108** | **89** | | |

\* `session`'s sixth declared name, `session.message.send`, is implemented in
`messaging/session-message-send.ts` and carries no policy at all — it's one of the 19
ungated operations below, not a sixth gated `session/operations.ts` entry. The five
gated session operations (`list`, `get`, `messages.list`, `state.update`, `interrupt`) are
all read directly in `session/operations.ts` and all route through `admitSpaceCaller`.

## Headline result: zero operations reach `execute` with no gate behind them

For all 89 role-declaring operations, the pipeline stage that runs immediately before
`execute` independently re-derives the caller's admitted role set from the **same constant**
the removed door check used (e.g. `AGENT_ROLES`, `WORKFLOW_READ_ROLES`, `FORGE_MUTATE_ROLES`,
`RETRY_ROLES`) and rejects with a typed, family-specific reason before any business logic
runs. I checked every call site, not a sample: `admitWorkflowScope(caller, spaceId,
WORKFLOW_READ_ROLES)` / `WORKFLOW_MUTATE_ROLES` in both workflow files; `admitEventCallerSpace(input,
caller, NODE_EVENT_ROLES | AGENT_EVENT_ROLES | INACTIVITY_ROLES | EXTERNAL_EVENT_READ_ROLES)`
across all six `external-events/*.ts` files; `admitSpaceCaller` fed the identical
`READ_ADMISSION`/`WRITE_ADMISSION` shape from `session/operations.ts`, `schedule/operations.ts`,
and `audit/operations.ts`; `admitAgentCaller` from seven `agents/*.ts` operation files
(`agent-template-operations.ts`, `assign-agent-operation.ts`, `create-agent-operation.ts`,
`get-agent-operation.ts`, `list-agents-operation.ts`, `reminder-operations.ts`,
`update-agent-operation.ts`);
`admitGoalRole`/`admitGoalSpace`/`admitGoalAccess` from nine `goals/*.ts` operation
files; `admitForgeReader`/`admitForgeMutator` from both `evolution/episode-operations.ts` and
`evolution/scope-operations.ts`; `admitNodeCaller` from the three `messaging/node-*.ts` list
operations and `send_message`; `admitArtifactCaller` from `artifacts/artifact-operations.ts`;
`admitRetrier` from `tasks/retry-task.ts`.

None of these gate functions changed in #4726. Per `git show --stat 57723b053`, the commit
touched two source files — `operations/invoke.ts` (the gate logic) and
`agents/reminder-operations.ts` (two operation description strings only, updated to stop
promising a door refusal that no longer happens; no admission logic changed there) — plus 25
test files. So **the count of operations a role newly reaches with no family gate at all is
0** among the 89 that declare a policy. The generic door was fully redundant with these gates
for every role-restricted operation; #4726 removed a second lock on a door that a first lock
still closes.

One structural fact worth stating because the issue asked how each role is "actually
reached": `resolveSpaceMcpSessionPolicy` (`space/runtime/space-mcp-session-policy.ts`) is
wired to the real `OperationCaller.role` seen at the door via
`resolveSessionCallerScope` → `createSpaceCallerScopeResolver`
(`space/runtime/space-caller-scope.ts`), which is what `createOperationMcpServer`'s
`resolveCaller` ultimately calls (`operations/mcp-server.ts` → `operations/caller.ts`). That
function can only return `direct_task_worker`, `legacy_task_agent`, `ad_hoc_member`,
`workflow_worker`, `universal_read`, or `long_term_agent` — it never produces `outside_space`.
Grepping the whole daemon for `'outside_space'` finds only the type declaration in
`operations/registry.ts`; every other appearance is a synthetic role in a test proving a gate
denies unknown roles. Combined with the fact that no family's role allowlist ever names
`direct_task_worker`, `legacy_task_agent`, or `outside_space`, those three roles are denied by
every one of the 89 gated operations regardless of #4726 — they were never admitted anywhere,
before or after.

Nothing about *whether* a session gets the `hyperneo-operations` MCP server varies by role: it
is attached unconditionally to every session by `QueryOptionsBuilder.computeEffectiveMcpServers`
(`agent/query-options-builder.ts:304`), and the registry behind it is one global registry
installed once via `sessionManager.setDefaultOperationRegistryProvider`
(`rpc-handlers/index.ts:1420`) with no session or role argument. `attachGenericSpaceTools`
(`space-mcp-session-policy.ts`) is a separate switch that only governs the `agent-memory` and
`db-query` servers. So every role difference this document describes is enforced entirely
inside the operations themselves (family gates, or now nothing at the door) — never by varying
which tools a session can see.

### Roles admitted per family (identical before and after #4726, enforced by the family gate)

| Family | `ad_hoc_member` | `long_term_agent` | `universal_read` | `workflow_worker` | `direct_task_worker` / `legacy_task_agent` / `outside_space` |
|---|---|---|---|---|---|
| agent (all 17) | yes | yes | no | no | no |
| goal (read: list/get/tasks.list/events.list/owner.get) | yes | yes | yes | no | no |
| goal (mutate: create/update/pause/resume/triggerTask) | yes | yes | no | no | no |
| goal (owner: reviewOutcome) | no | yes | no | no | no |
| forge (read) | yes | yes | yes | no | no |
| forge (mutate/destructive) | yes | yes | no | no | no |
| workflow (list/suggest/get/run.get) | yes | yes | yes | yes | no |
| workflow (changePlan) | yes | yes | no | no | no |
| schedule/session/audit (read) | yes | yes | yes | yes | no |
| schedule/session (mutate/destructive) | yes | yes | no | no | no |
| node.* / send_message / artifact.* | no | no | no | yes | no |
| task.retry | yes | yes | no | no | no |
| externalEvent.get (read) | yes | yes | no | yes | no |
| externalEvent.agent.* | yes | yes | no | no | no |
| externalEvent.listDeliveries, .subscribe/unsubscribe/listSubscriptions, nodeAgent.restore | no | no\* | no | yes\* | no |
| externalEvent.inactivity.* | no | yes | no | no | no |

\* `externalEvent.listDeliveries` and `inactivity.*` are two separate exceptions inside
externalEvent, not one. `listDeliveries` (`list-deliveries-operation.ts`) is gated by
`NODE_EVENT_ROLES = ['workflow_worker']`, the same constant as `.subscribe`/`unsubscribe`/
`listSubscriptions`/`nodeAgent.restore` — it does not share the `get` row's
`EXTERNAL_EVENT_READ_ROLES` despite being grouped with `get` under "read" above; `ad_hoc_member`
and `long_term_agent` are denied. `inactivity.*` uses `INACTIVITY_ROLES = ['long_term_agent']`
only, admitting neither `ad_hoc_member` nor `workflow_worker`.

## The one real, confirmed regression: discovery, not execution

`operations.list` and `operations.describe` (`operations/discovery.ts`) filter through
`isOperationAdmitted` too, and they have no family gate behind them — they're pure catalog
reads. Before #4726, an `ad_hoc_member` calling `operations.list` would not see
`node.peers.list` or `send_message` (`workflow_worker`-only); `agentTemplate.*` is not an
example of this — every `agentTemplate.*` policy uses `AGENT_ROLES = ['ad_hoc_member',
'long_term_agent']` (`agents/operation-contracts.ts`, `agents/agent-template-operations.ts`),
so `ad_hoc_member` always saw it, before and after #4726. A `universal_read` caller wouldn't
see any mutate/destructive operation. Now every MCP caller,
in every role, sees **all 108 operation names and descriptions** via `operations.list`, and
`operations.describe` will hand back the full input/output JSON Schema for **any** operation
by name, including ones that role will be rejected from executing a moment later. This is
confirmed by the updated `discovery.test.ts` assertions (`'a role outside the roles list
still sees every operation in the catalog'`, `'findDescribedOperation no longer hides any
operation from a caller'`) and matches the production code path (`listOperationSummaries` /
`findDescribedOperation` still call `isOperationAdmitted`, which is now always `true`).

Concretely, an `ad_hoc_member` session (a Space chat member, not a workflow worker, not a
long-term agent) can now call `operations.describe` with `{ name: 'forge.rollup.apply' }`,
`{ name: 'schedule.delete' }`, or `{ name: 'session.interrupt' }` and get back the exact input
shape and description for operations it cannot invoke — it will still be rejected with
`forge_denied` / `denied` if it tries. This is recon information (parameter names, what the
operation does, what it returns), not data or a capability. I could not find any operation
whose *description* field leaks data beyond what the schema itself says, so I'm not treating
this as more than a visibility regression, but it is real and it is the only thing that
changed observably for any role that a family gate doesn't already re-cover.

## The 19 operations with no policy at all — unaffected by #4726

`isOperationAdmitted`'s old code was `if (!policy) return true` before #4726 too, so these
were already reachable by every MCP role and every role's reachability here is unchanged:

- 14 standalone task operations: `task.transition`, `task.cancel`, `task.dependencies.set`,
  `task.setPreferredWorkflow`, `task.create`, `task.update`, `task.resolvePendingCompletion`,
  `task.list`, `task.submitForReview`, `task.get`, `task.complete`, `task.start`,
  `task.members.list`, `task.archive`
- `operations.list`, `operations.describe` themselves
- `message.send`, `task.message.send`, `session.message.send`

These aren't role-gated, but several still enforce **session/space scoping** unrelated to
role: e.g. `admitManagedCancellation` in `tasks/cancel-task.ts` requires the caller's own
session to be `active` and resolve to the *same* `spaceId` as the task being cancelled,
regardless of what role that session carries. I spot-checked `task.cancel` only; I did not
re-verify the other 13 task operations' scope checks individually since they predate #4726
and are out of the delta this sweep is about.

## What this method could not verify

- I did not boot a real daemon and drive the `hyperneo-operations` MCP server end-to-end; I
  used `invokeOperation`/`operation.execute` directly against the real production factories,
  as the issue said to prefer. I did not independently re-verify that the MCP transport wires
  `resolveCaller` to `resolveSessionCallerScope` for every session type in the live daemon —
  I traced the import graph (`mcp-server.ts` → `caller.ts` → `space-caller-scope.ts` →
  `resolveSpaceMcpSessionPolicy`) but did not exercise a live `QueryOptionsBuilder.build()`
  call.
- I verified the family gate exists and matches the declared `policy.roles` for all 89
  operations by reading every call site of the function that constructs each role-list
  constant, and by running the existing tests that already exercise at least one denied role
  per family. I did **not** write and run 89 fresh invocations myself, one per operation —
  the existing tests, being built on the same production factories, are equivalent evidence
  for the specific question ("is there a gate, and does it match"), and re-deriving the same
  result by hand for each operation would not have added confidence, only cost. If a family's
  gate silently diverges from its declared policy in a way no existing test's chosen role
  combination happens to expose, this sweep would not catch it.
- For the 19 policy-free operations, I checked only `task.cancel`'s independent scope check
  as a representative sample; I did not audit the other 13 task operations or the 3
  message-send operations for whether they have any independent scope gate at all. If one of
  them turns out to have none, it would be a pre-existing full-open surface, not something
  #4726 changed — still worth a follow-up, but a different question than this issue asks.
- I did not attempt to drive any of the 89 gated operations through to a successful
  `execute()` completion under an *admitted* role (i.e., past the family gate and through
  real business logic) — that wasn't needed to answer "is there a gate," and building 89
  realistic input payloads plus backing rows (goals, agents, forge scopes, workflows,
  schedules) was disproportionate to the question. Every rejection I observed came back as a
  typed `{ kind: 'completed', value: {...} }` gate rejection, never `execution_failed`, so
  there's no ambiguity in this sweep between "the gate rejected it" and "it crashed
  downstream" for the denied cells specifically.

## Answers

- **Operations reachable by a role with no gate behind them: 0**, among the 89 that declare
  a `policy.roles` list. Every one of them is independently re-checked by a family-owned
  admission function that was untouched by #4726 and derives from the same role-list constant
  the door used to enforce.
- **Three most consequential newly-exposed things**, since the execution surface didn't
  change: the `operations.list`/`operations.describe` catalog leak is the only real,
  confirmed regression, so the three most consequential *visible-but-not-invocable* schemas
  it now exposes to every role are `schedule.delete` (destructive, previously hidden from
  everyone but `ad_hoc_member`/`long_term_agent`), `session.interrupt` (destructive), and
  `forge.rollup.apply` (destructive) — an `ad_hoc_member` or `universal_read` caller can now
  read exactly how to call these even though calling them still fails with `denied` /
  `forge_denied`.
- **What the method couldn't verify** is listed in full above; the short version is: no live
  daemon / real MCP transport run, no fresh 89-operation micro-harness (existing tests stood
  in for it), and 13 of the 14 policy-free task operations (all but `task.cancel`) not
  individually audited for independent scope gates.
