# Measuring the web's migration to the operations door

Companion to [`rpc-mcp-unification-current.md`](./rpc-mcp-unification-current.md),
[`rpc-mcp-unification-target.md`](./rpc-mcp-unification-target.md) and
[`rpc-mcp-unification-gap.md`](./rpc-mcp-unification-gap.md). Those describe the two doors and
what is missing between them. This one sizes the last move: the web stops calling the bespoke
RPC handler surface and calls `operation.invoke` instead, and the handlers are deleted.

Measured against `dev` @ `400f5f89c` (2026-09-15). Every number below comes from a script in
the repo tree, not from a description; the commands are in the last section. Counts of open
PRs are a point-in-time read of the twelve port branches listed there.

**The headline.** 210 request methods, 6,382 lines of handler body, 312 web call sites, and
19 operations to land them on. The task family already made the trip and is the calibration
for everything else. The migration is not blocked on the daemon: ported family operations
reach the registry that `operation.invoke` serves, so each port lane's merge unblocks its
family's web swap directly. It is blocked, for a subset of operations, on the fact that the
RPC door still has no caller identity.

## 1. The RPC surface, by family

### Where methods are registered

`MessageHub.onRequest` is the only registration form, but it appears three ways: a bare
literal, a `method('x')` helper that prefixes a file-level `METHOD_PREFIX`, and an
`onRequest<Req, Res>(...)` generic call whose name is the first argument after the type
parameters. A grep for `onRequest('` finds 163 of them and silently misses 47, so the count
below comes from a scanner that skips balanced `<...>` before reading the name.

| Location | Files | File lines | Methods |
| --- | --- | --- | --- |
| `packages/daemon/src/lib/rpc-handlers/` | 38 | 16,748 | 195 |
| `lib/external-events/github/github-event-extension.ts` | 1 | 3,480 | 15 |
| **Total business RPC** | **39** | **20,228** | **210** |
| `lib/state-projection-service.ts` (state snapshot channels) | 1 | 492 | 3 |

The three state channels (`state.global.snapshot`, `state.session`, `state.sdkMessages`) are a
separate snapshot/merge mechanism reached through `lib/state-channel.ts`, not business calls;
they are excluded from every table below. `lib/acp/acp-transport.ts` has an `onRequest`
*option* on the ACP subprocess protocol — a different transport, not the web hub.

Only 6,382 of those 20,228 lines sit inside the 210 handler callbacks. The remainder is
dependency wiring, SQL, and helpers — much of it shared with the code an operation would call,
so the handler-body figure is the honest deletion budget and the file total is not.

### Per-family surface

"Reads" are name-verb classified (`.list`, `.get`, `.search`, `.preview`, `.count`, and the
explicit read-shaped names such as `.getCommits` or `.listHookStates`); everything else is a
command. `Lines` is the summed span of the handler callbacks, not the files.

| Family | Methods | Reads | Commands | Handler lines | Handler files |
| --- | --- | --- | --- | --- | --- |
| session | 49 | 17 | 32 | 1,469 | session, message, question, rewind, reference, git, voice, dialog |
| workflow | 21 | 13 | 8 | 961 | space-workflow, space-workflow-run, space-node-execution |
| external-event | 19 | 8 | 11 | 409 | github-event-extension, index |
| agent | 18 | 7 | 11 | 265 | space-agent-v2, -subscription, -reminder, agent-memory |
| skills/MCP | 18 | 3 | 15 | 340 | skill, app-mcp, space-mcp, mcp |
| provider | 18 | 7 | 11 | 718 | provider, custom-endpoint, auth |
| forge/evolution | 16 | 6 | 10 | 162 | evolution |
| space | 14 | 5 | 9 | 974 | space, space-export-import |
| goal | 11 | 4 | 7 | 114 | space-goal |
| workspace | 7 | 1 | 6 | 81 | workspace, space |
| other | 6 | 2 | 4 | 458 | live-query, settings, system, operation |
| schedule | 6 | 2 | 4 | 61 | task-schedule |
| template | 5 | 2 | 3 | 38 | space-agent-template |
| task | 2 | 0 | 2 | 332 | space-task-message |
| **Total** | **210** | **77** | **133** | **6,382** | |

**The task family is nearly gone already.** Two methods remain
(`space.task.sendMessage`, `space.task.activateNodeAgent`); everything else was deleted across
#4537, #4576 and the swaps below. That is the shape the other families are heading for.

### Reads served by LiveQuery, not by request/response

`live-query-handlers.ts` is 4,717 lines — 28% of the handler directory — but registers only two
methods, `liveQuery.subscribe` and `liveQuery.unsubscribe`. Behind them sits
`NAMED_QUERY_REGISTRY`, 16 named queries:

```
actorMessages.byTask          actorMessages.byWorkflowRun   mcpEnablement.bySpace
mcpServers.global             messages.bySession            nodeExecutions.byRun
sessionGroupMessages.byGroup  sessions.list                 skills.list
spaceSessions.bySpace         spaceTaskActiveTurn.byTask    spaceTaskActivity.byTask
spaceTaskMessages.byTask      spaceTaskMessages.byTask.compact
spaceWorkspaces.bySpace       taskMilestones.byTask
```

All 16 are subscribed to from the web. These are push subscriptions with snapshot and delta
events, not request/response reads, and `defineOperation` has no subscription shape: an
operation returns one validated result. **LiveQuery reads are out of scope for this
migration** and the two `liveQuery.*` methods stay on RPC. Any plan that counts the 4,717
lines as deletable is wrong by that whole file.

## 2. The web call sites, by family

### How the web calls the hub

Three entry points, all landing on `MessageHub.request`:

- `hub.request(name, data)` after `connectionManager.getHubIfConnected()` — the dominant form.
- `request(name, data)` destructured from `useMessageHub()` (`hooks/useMessageHub.ts:95`), a
  generic pass-through typed `method: string`.
- `callIfConnected(name, data)` from the same hook (`hooks/useMessageHub.ts:49`), which returns
  `null` instead of throwing when disconnected — 6 call sites.

`packages/ui/src` never touches the hub: **0 call sites.** The migration is entirely inside
`packages/web/src`.

312 production call sites (plus 8 in web tests). Ten are dynamic: three are the generic wrappers
in `useMessageHub.ts` themselves, one is `state-channel.ts` passing its channel name, two are
`STATE_CHANNELS` snapshot reads, and four are ternaries that select between two RPC names
(`SpaceExternalEventsSettings.tsx:325,489`, `space-store.ts:3039`, `FileDiffView.tsx:128`).
Counting each ternary against both names it can dispatch gives 306 (call site → RPC name)
bindings across 302 business call sites.

| Caller kind | Call sites |
| --- | --- |
| store (`lib/*-store.ts`) | 115 |
| component | 103 |
| lib (`api-helpers.ts`, `state-channel.ts`, `voice/*`) | 54 |
| hook | 35 |
| island | 5 |

**Two files carry 36% of the surface.** `lib/space-store.ts` has 72 call sites and
`lib/api-helpers.ts` has 40. Both are already the seam the task migration went through — the
`invokeOperation` swaps in #4545 and #4562 landed in `space-store.ts` — so most family swaps
are edits to one or two files, not a sweep.

| File | Call sites |
| --- | --- |
| `lib/space-store.ts` | 72 |
| `lib/api-helpers.ts` | 40 |
| `components/space/SpaceForge.tsx` | 21 |
| `components/space/SpaceExternalEventsSettings.tsx` | 15 |
| `components/space/SpaceSettings.tsx` | 9 |
| `lib/skills-store.ts`, `lib/session-store.ts`, `components/space/WorkflowList.tsx` | 8 each |

### Per-family call sites

`Files` is the number of distinct web files the swap must touch. `Names used` is how many of
the family's RPC methods the web actually calls.

| Family | Call sites | Files | Names used | Methods with no web caller |
| --- | --- | --- | --- | --- |
| session | 75 | 33 | 49 | 0 |
| other (LiveQuery, settings, usage, system) | 49 | 14 | 6 | 0 |
| forge/evolution | 23 | 3 | 16 | 0 |
| workflow | 23 | 5 | 19 | 0 |
| agent | 21 | 3 | 17 | 1 |
| external-event | 20 | 3 | 18 | 0 |
| provider | 20 | 3 | 18 | 0 |
| skills/MCP | 20 | 6 | 18 | 0 |
| space | 18 | 4 | 14 | 0 |
| goal | 9 | 1 | 9 | 0 |
| workspace | 9 | 4 | 7 | 0 |
| schedule | 6 | 1 | 6 | 0 |
| template | 5 | 1 | 4 | 1 |
| task | 2 | 1 | 2 | 0 |

**Almost nothing is dead.** 208 of 210 methods have at least one production web caller. The two
that do not are `spaceAgentV2.get` (7 lines) and `spaceAgentTemplate.listBuiltIn` (8 lines,
referenced only by `space-store.test.ts` mocks that assert it is *not* called). Those are
delete-only slices with no web work, worth ~15 lines together — not a family.

## 3. The mapping

### What exists and what is in flight

`packages/shared/src/types/operation-names.ts` on `dev` holds 19 names, almost all `task.*`:

```
message.send  operations.describe  operations.list  session.message.send
task.archive  task.cancel  task.complete  task.create  task.dependencies.set
task.get  task.list  task.members.list  task.message.send
task.resolvePendingCompletion  task.setPreferredWorkflow  task.start
task.submitForReview  task.transition  task.update
```

Twelve open PRs add roughly 40 more. None of them is merged to `dev` yet — `git log origin/dev
--grep=port` shows the subsystem *moves* landed but no family port did.

| Port PR | Operations added | Nearest RPC methods |
| --- | --- | --- |
| #4617, #4624 | `agent.list`, `agent.get`, `agent.create` | `spaceAgentV2.list`, `.get`, `.create` |
| #4618, #4622 | `goal.list`, `goal.get`, `goal.tasks.list`, `goal.events.list` | `spaceGoal.list`, `.get`, `.listEvents` |
| #4619, #4628 | `externalEvent.listDeliveries`, `.get`, `.subscribe`, `.listSubscriptions`, `.unsubscribe` | `space.externalEvents.listDeliveries`, `externalEvents.extensions.*` |
| #4620 | 13 `forge.*` (scope, evidence, metric, note, timeline) | `evolution.*` (16 methods) |
| #4621 | `schedule.create`, `.delete`, `.get`, `.list`, `.pause`, `.resume` | `taskSchedule.*` (all 6) |
| #4627 | `workflow.list`, `workflow.suggest` | `spaceWorkflow.list`, `.listBuiltInTemplates` |
| #4623, #4626 | `node.channels.list`, `node.peers.list`, `node.reachableAgents.list` | none — agent-facing topology |
| #4625 | `inactivity.config.get`, `.set`, `.setEnabled`, `inactivity.runNow` | none — no RPC watchdog surface |

**The port lanes are porting legacy Space actions, not RPC handlers**, so "nearest" is doing
real work in that table. `goal.list` descends from the `list_goals` dispatcher action and
inherits that action's input shape and admission, not `spaceGoal.list`'s; the two overlap in
intent but not in signature, and section 3.3 is the delta. The last two rows have no RPC
counterpart at all — they give agents capability the web never had, so they add nothing to the
web's swap and remove nothing from the deletion budget.

### Families with no operation, and why

| Family | RPC methods | Status |
| --- | --- | --- |
| session | 49 | No lane. Session lifecycle, drafts, model/thinking switches, rewind, references, voice, git, dialogs. Almost none of it is a Space business path; `message.send` and `session.message.send` are the only operations that exist. |
| provider | 18 | No lane, and arguably none is wanted: `auth.*`, `providers.*`, `customEndpoints.*` are daemon configuration, not agent-callable capability. |
| skills/MCP | 18 | No lane. Enablement overrides are a policy surface (session > room > space > default) that an operation catalog has no vocabulary for yet. |
| space | 14 | Partly covered by #4625's watchdog ops. `space.create/delete/archive/start/stop/pause/resume`, export and import have no lane. |
| workspace | 7 | No lane. `space.workspace.*` is the registered-workspace surface from `docs/features/space-workspaces.md`. |
| template | 5 | No lane. |
| workflow | 21 | #4627 and #4623/#4626 cover catalog reads and node topology — 2 of 21. Run inspection (commits, diffs, artifacts, hook states, approve/retry) has no lane. |
| goal | 11 | #4618/#4622 cover 4 reads. The 7 writes (create, update, pause, resume, owner assignment, `createImmediateTask`) have no lane. |
| agent | 18 | #4617/#4624 cover 3. Subscriptions, reminders and `agentMemory.*` (13 methods) have no lane. |

### Shape differences the web will feel

Four of them, each measurable today.

**Result envelopes invert.** Every `spaceGoal.*` handler returns a bare domain envelope —
`space-store.ts:2858` destructures `{ goals }`, `:2875` `{ goal }`, `:2972` `{ events }`. The
ported operation returns a discriminated union on `accepted`:

```
resultSchema: z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true), goal: SpaceGoalSchema }),
  GoalRejectionSchema,                       // { accepted: false, reason, message }
])
```

So `const { goals } = await hub.request(...)` becomes a check on `accepted` and a branch that
turns `reason` into a message. That is the bulk of the per-call-site cost, and it is why
`lib/operations.ts` already carries per-operation wrappers rather than a single generic call —
`setPreferredWorkflow` maps three rejection reasons to prose in 15 lines.

**`spaceId` stops being free.** `resolveGoalSpaceId` in #4618 short-circuits for non-MCP
callers: an MCP caller gets `caller.spaceId` from its session, an RPC caller must pass
`spaceId` in the input or is denied `space_unresolved`. Today the web already passes `spaceId`
on every `spaceGoal.*` call, so for that family this costs nothing — but it is a rule the web
must keep honouring, and families whose handler derives the Space from a session id will gain a
required field.

**Some rejections stop being exceptions.** The RPC handlers throw:
`space-goal-handlers.ts:52` throws `Goal not found: ${goalId}`, `:66` throws from
`requireSpace`. Operations return `{ accepted: false, reason }` for domain rejections and
reserve throws for infrastructure faults. Any web `catch` that today renders a thrown
handler string must move to the `accepted: false` branch or the error will silently become a
success value.

**Long-running work returns a job.** Per ADR 0006 an operation that cannot finish inline
returns `{ accepted: true, jobId }`. No current web call site expects that shape.
`space.task.activateNodeAgent`, `spaceImport.execute`, `spaceWorkflow.resyncDuplicates` and
`providers.test` are the handlers most likely to acquire it.

**Handlers do work operations do not.** 27 `internalEventBus` references and 30 `.publish(`
calls live in the handler directory, concentrated in `rpc-handlers/index.ts` (39),
`space-handlers.ts` (17), `session-handlers.ts` (16), `provider-handlers.ts` (14),
`space-workflow-handlers.ts` (13) and `space-agent-v2-handlers.ts` (10). `space-agent-v2-handlers.ts`
alone publishes `spaceAgentV2.created`/`.updated`/`.deleted` *and* mirrors each to the
unified-agent topic via `publishUnifiedAgentCreated`/`Updated`/`Deleted`. If an agent operation
does not republish those, the web's subscriptions go quiet after the swap and the UI stops
updating — with no test failure, because the operation's own result is correct.
`space-goal-handlers.ts` (4) and `space-workflow-run-handlers.ts` (5) are the light ones;
`task-schedule-handlers.ts` and `evolution-handlers.ts` publish nothing at all.

## 4. What the web lacks

### The client already exists

`packages/web/src/lib/operations.ts` (58 lines) is the typed client:

```
export function invokeOperation<T>(hub: MessageHub, name: OperationName, input?: unknown): Promise<T>
```

`name` is typed `OperationName` from `@hyperneo/shared/types/operation-names`, so adding a name
to that array is what makes it callable. `input` is `unknown` and the result type is a caller-
supplied type parameter — the client is *name*-typed, not *shape*-typed. Eleven production call
sites use it, all `task.*`, all from `space-store.ts` plus the three wrappers in the file
itself. **No new client module is needed**; the gap is types.

### The smallest way to give the web result types

The constraint that decides this: **`packages/shared` has zero runtime dependencies and
`packages/web` does not ship zod.** `zod@4.6.2` is a dependency of `packages/daemon` only. The
only zod in shared is a type-only import inside the vendored `src/sdk/sdk.d.ts`.

| Option | Cost | Verdict |
| --- | --- | --- |
| Move the operation zod schemas into `packages/shared` | Adds zod to shared's dependency set and to the web bundle for all 19 (soon ~60) operations. One source of truth, runtime validation on the client. | Rejected on bundle cost unless the web wants client-side validation, which nothing today asks for. |
| Generate `.d.ts` from the daemon schemas | New build step, new generated artifact in a repo whose knip config already treats unimported modules as failures. | Rejected: a codegen step for ~60 types is more machinery than the types are worth. |
| Hand-written result contracts in `packages/shared/src/types/` | ~1 interface per operation, type-only, zero runtime cost. Risk: drift from the zod schema, caught only by a daemon test that asserts the schema matches the interface. | **Recommended.** |

The reason hand-written contracts are cheap here is that **most result types already exist in
shared**: `types/space.ts` (1,394 lines) holds `SpaceTask`, `SpaceGoal`, `SpaceGoalEvent`,
`SpaceGoalOwnerResolution` and the workflow types; `types/space-agent.ts` (61), `task-core.ts`
(31), `evolution.ts` (303), `github.ts` (103), `skills.ts` (65) and `rewind.ts` (35) cover the
rest. The web already imports them at its call sites — `space-store.ts:2858` annotates
`hub.request<{ goals: SpaceGoal[] }>` by hand today. What is missing is only the envelope:

```
export type OperationResult<T> = { accepted: true } & T | { accepted: false; reason: string; message?: string };
```

One generic in shared plus a per-operation alias is the whole contract. Budget: ~30 lines for
the generic and the rejection type, then ~2 lines per operation.

## 5. A slice plan

### Budgets

The web-swap budget is calibrated on the two merged task swaps, which are the only measured
evidence: #4545 (`task.list`, 1 call site) changed 11 lines in `space-store.ts`; #4562
(`task.update`, 2 call sites) changed 17 lines in `space-store.ts` plus 15 new lines in
`operations.ts`. That gives ≈10 prod lines per call site swapped and ≈12 lines per operation
wrapper that needs rejection decoding. The daemon deletion budget is the measured handler-body
span and needs no calibration.

| Family | Web swap (prod lines) | Daemon deletion (prod lines) | Slices | Must land first |
| --- | --- | --- | --- | --- |
| schedule | ~130 | 61 | 1 swap + 1 delete | #4621 |
| goal (reads) | ~90 | 34 | 1 swap + 1 delete | #4618, #4622 |
| template | ~100 | 38 | 1 swap + 1 delete | none (no lane) |
| workspace | ~175 | 81 | 1 swap + 1 delete | none (no lane) |
| agent (reads + create) | ~75 | 18 | 1 swap + 1 delete | #4617, #4624 |
| goal (writes) | ~110 | 80 | 2 | a goal-writes lane |
| forge/evolution | ~420 | 162 | 2 swap + 1 delete | #4620 |
| external-event | ~415 | 409 | 2 swap + 2 delete | #4619, #4628 |
| agent (subs, reminders, memory, remaining V2) | ~340 | 247 | 2 swap + 2 delete | an agent-extras lane |
| skills/MCP | ~415 | 340 | 2 swap + 2 delete | an enablement lane |
| space | ~350 | 974 | 2 swap + 3 delete | a space-lifecycle lane |
| workflow | ~460 | 961 | 3 swap + 3 delete | #4627 + a run-inspection lane |
| provider | ~415 | 718 | — | stays on RPC |
| session | ~1,340 | 1,469 | — | stays on RPC for now |
| **Stays on RPC** | | | | |
| LiveQuery (`liveQuery.*`) | 0 | 0 | — | no subscription shape in `defineOperation` |
| state channels | 0 | 0 | — | separate snapshot mechanism |

Every family except session and workflow fits the ~300 prod-line PR limit as one swap slice
plus one deletion slice. Session does not fit at any granularity and should be cut by
sub-surface (drafts, model/thinking, rewind, voice, references) if it is attempted at all.

### Readiness order

1. **schedule** — 6 methods, 6 call sites, one file (`space-store.ts`), 61 lines to delete,
   zero `internalEventBus` publishes in `task-schedule-handlers.ts`, and #4621 ships all six
   operations. The cleanest first slice in the repo.
2. **goal reads** — 9 call sites in one file, 4 operations in #4618/#4622, 4 publishes in the
   handler. Small, and it exercises the `{ accepted }` envelope change on a real family.
3. **template** and **workspace** — no lane, but tiny (38 and 81 handler lines, 5 and 9 call
   sites). Worth building the operations inside the same epic rather than waiting.
4. **agent reads + create** — #4617/#4624. Held back from the top only because
   `space-agent-v2-handlers.ts` publishes to two topics per mutation; the create swap must
   carry that forward.
5. **forge/evolution** — 13 operations in one PR (#4620) against 16 RPC methods, 23 call sites
   in 3 files, 162 handler lines, zero publishes in `evolution-handlers.ts`. High method count
   but mechanically simple; the 21 call sites in `SpaceForge.tsx` are the only real work, and
   the three RPC methods #4620 does not cover need identifying before the deletion slice.
6. **external-event** — #4619/#4628 cover the read side; the 15 `space.github.*` methods in the
   extension are a separate surface with its own lane still to be written.
7. **agent extras, skills/MCP, goal writes** — need lanes that do not exist.
8. **space**, then **workflow** — largest deletion budgets (974 and 961 lines), most E2E
   exposure, least lane coverage.
9. **provider**, **session** — no lane, and no clear argument that these are agent-callable
   business paths at all. Decide whether they belong in the operations model before sizing them.

### E2E gates

`packages/e2e` has 49 `hub.request` calls across 12 files. They are setup and teardown, which
the E2E rules permit; the constraint is that they name RPC methods, so a deletion breaks them.

| RPC method | E2E calls | Gates deletion of |
| --- | --- | --- |
| `operation.invoke` | 13 | already migrated |
| `space.create` | 6 | space |
| `space.delete` | 5 | space |
| `session.delete` | 4 | session |
| `spaceWorkflow.list` | 3 | workflow |
| `spaceWorkflow.create` | 3 | workflow |
| `session.create` | 3 | session |
| `spaceWorkflow.delete` | 1 | workflow |
| `space.task.sendMessage` | 1 | task |
| `state.global.snapshot` | 1 | state channel (not migrating) |

Only three families are gated: **space** (11 calls), **session** (7) and **workflow** (7). The
heaviest files are `space-happy-path-pipeline.e2e.ts` (11), `helpers/wait-helpers.ts` (6) and
`space-artifacts-panel.e2e.ts` (6). Schedule, goal, forge, template, workspace, agent and
skills/MCP have **no E2E dependency at all** — those families can be deleted without touching
`packages/e2e`.

**One E2E call is already broken.** `space-happy-path-pipeline.e2e.ts:168` calls
`space.task.ensureAgentSession`, which no longer exists: the only `ensureAgentSession` in the
daemon is a `SpaceRuntimeService` method (`space/runtime/space-runtime-service.ts:748`) with no
RPC registration. That call either throws and is swallowed, or the test is not running. Worth a
separate fix, not part of this migration.

## 6. Blockers

**The RPC door has no caller identity, and the policy layer is a no-op for it.**
`setupOperationHandlers` passes `() => ({})` as the caller resolver
(`rpc-handlers/operation-handlers.ts:6`), so every web invocation arrives as bare
`{ source: 'rpc' }`. `isOperationAdmitted` (`operations/invoke.ts:53`) opens with
`if (caller.source !== 'mcp') return true` — so `safetyClass: 'human_only'` and every role
restriction are skipped entirely for RPC. The ported gates do the same:
`admitGoalRole` and `admitGoalSession` in #4618 both begin `if (caller.source !== 'mcp') return
{ value: true }`. Two consequences worth stating separately:

- This is not a regression. The bespoke handlers are equally unauthenticated, so moving the web
  onto `operation.invoke` does not weaken anything that is enforced today.
- But it caps what can move. Any operation whose semantics need to know *which human* acted —
  approvals (`spaceWorkflowRun.approveHook`), audit trails, ownership assignment
  (`spaceGoal.assignOwner`) — cannot be modelled honestly until an authenticated connection
  principal exists. `CallContext.sessionId` is client-supplied wire payload and must not be
  promoted into an actor. Note that #4491 (audit hooks on the invoke pipeline) is open: an audit
  hook that records a bare `{ source: 'rpc' }` records nothing useful.

**LiveQuery and operations solve different problems.** 49 of the 312 web call sites are
`liveQuery.subscribe`/`unsubscribe`, and the stores are built around snapshot-plus-delta
subscriptions that re-sync on reconnect and on `MESSAGE_TOO_LARGE`. `defineOperation` returns
one validated value. Until there is a reactive shape in the operations model — which is a
design question, not a slice — the reads behind those 16 named queries stay on RPC, and any
family whose web reads come from a LiveQuery rather than a request keeps a foot in both doors
after its swap.

**Broadcast side effects are invisible to operation tests.** Quantified in section 3.3. The
specific hazard is `space-agent-v2-handlers.ts`, which publishes to both a `spaceAgentV2.*`
topic and the unified-agent topic on every mutation. An operation that returns the right value
but publishes neither will pass its own tests and freeze the UI. Any agent, space, workflow or
provider swap needs an explicit check that the operation republishes what the handler did —
per ADR 0006 this belongs in the operation, not the adapter.

**Operation gates are stricter than the handlers they replace.** #4618's `goal.get` requires
`spaceId` from an RPC caller or denies `space_unresolved`; the RPC handler derived nothing and
simply looked the goal up. Every swap must diff the gate against the handler before rewiring,
or the web will start seeing rejections where it used to see data.

**Nothing has landed yet.** All twelve port PRs are open against `dev`; `operation-names.ts` on
`dev` still has 19 names. Every web slice below the task family is downstream of a merge that
has not happened, so the sequencing in section 5 is a readiness order, not a schedule.

**One thing that is not a blocker.** Ported family operations *do* reach the RPC door.
`rpc-handlers/index.ts:1268` builds `familyOperations`, passes it to
`createSpaceOperationRegistryProvider` (`:1378`), which becomes the session manager's default
registry — and `setupOperationHandlers` reads exactly that
(`index.ts:340`, `() => deps.sessionManager.getOperationRegistry()`). The per-session MCP
registry in `space-runtime-service.ts:892` layers legacy actions *on top of* the same base. So a
port lane's merge makes its operations callable from the web immediately; no second registration
step is needed.

## Commands

Run from the repo root. The three scanners are ~40 lines each and were not committed; they are
reproduced by the descriptions here and the greps below.

```bash
# RPC registrations: literal, method('x'), and onRequest<Req,Res>( forms.
# A naive grep undercounts — it finds 165 of 210.
grep -rn "onRequest('" packages/daemon/src/lib/rpc-handlers/ | wc -l
grep -rn "onRequest" packages/daemon/src --include='*.ts' | grep -v ionRequest | cut -d: -f1 | sort | uniq -c

# Handler directory size.
wc -l packages/daemon/src/lib/rpc-handlers/*.ts | tail -1
wc -l packages/daemon/src/lib/external-events/github/github-event-extension.ts

# Named LiveQuery definitions.
sed -n '4138,4345p' packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts \
  | grep -c "^\s*'[a-zA-Z.]*',"

# Web call sites: hub.request, destructured request, callIfConnected.
grep -rn "\.request(\|callIfConnected(" packages/web/src --include='*.ts' --include='*.tsx' \
  | grep -v __tests__ | wc -l
grep -rn "request(" packages/ui/src --include='*.ts' --include='*.tsx' | wc -l   # 0

# Call-site concentration.
grep -rno "request(\s*'[a-zA-Z.]*'" packages/web/src --include='*.ts' --include='*.tsx' \
  | grep -v __tests__ | cut -d: -f1 | sort | uniq -c | sort -rn | head

# Side effects in handlers.
grep -rn "internalEventBus\|\.publish(" packages/daemon/src/lib/rpc-handlers/ \
  | cut -d: -f1 | sort | uniq -c | sort -rn

# E2E RPC dependency.
grep -rhno "request(\s*'[a-zA-Z.]*'" packages/e2e --include='*.ts' \
  | sed "s/.*'\(.*\)'/\1/" | sort | uniq -c | sort -rn

# Operations on dev, and the names the port lanes add.
cat packages/shared/src/types/operation-names.ts
gh pr list --repo lsm/HyperNeo --state open --search port
gh pr diff <n> --repo lsm/HyperNeo | grep -E "^\+\s+'[a-z][A-Za-z]*\.[A-Za-z.]+',"

# zod is a daemon dependency only.
grep -n '"zod"' packages/*/package.json

# Web swap calibration.
git show --stat 42789d4b8f   # task.list  — 1 call site
git show --stat 92ce2a6ad4   # task.update — 2 call sites
```
