# RPC/MCP unification: methodology and design pattern

This guide distills the HyperNeo unification stream into a reusable approach for other agents. It describes the implemented architecture and separates it from unfinished work. Status snapshot (2026-09-12 UTC): shared start/retry exposure is still under review in [PR #4391](https://github.com/lsm/HyperNeo/pull/4391); guardian-based daemon-crash recovery is explicitly parked.

## 1. Define the operation once

The unit of reuse is a domain operation, not a human handler or an agent tool.

Each operation defines:

- A stable domain name, such as `task.update`, `task.submitForReview`, or `task.cancel`.
- A description of its actual behavior and supported scope.
- An input schema and a result schema.
- One execution function accepting validated input and trusted caller context.

Avoid names such as `agentActions` for functionality humans also use. Avoid a `space` prefix when Space is an ownership or execution context rather than the identity of the operation. A generic name does not imply universal support: document which task types the current binding supports.

```text
Human/UI -- RPC adapter --+
                         |
Agent ---- MCP adapter --+--> operation registry / shared invoker
                         |       resolve -> validate input -> execute -> validate result
Internal caller ---------+                            |
                                                      v
                                         domain operation pipeline
                                         policy + decisions + effects
                                                      |
                                         repositories / managers / jobs
```

The existing contract is structurally:

```ts
interface OperationEntry<Input, Output> {
  name: string;
  description: string;
  inputSchema: Schema<Input>;
  resultSchema: Schema<Output>;
  execute(input: Input, caller: OperationCaller): Promise<Output>;
}
```

`Schema` above is illustrative; the implementation uses Zod. `OperationCaller` currently contains `source: 'rpc' | 'mcp' | 'internal'` and an optional `sessionId`.

## 2. Keep transport adapters thin

RPC and MCP both invoke the same registry entry through the same invoker.

Adapters handle transport concerns: invocation-envelope parsing, trusted caller resolution, response formatting, and protocol error mapping. They do not implement a second task transition, retry policy, database mutation, or event sequence.

The current RPC entry point is `operation.invoke`. The MCP operations server exposes an `invoke` tool. `operations.list` and `operations.describe` discover entries and derive their schemas from the registry at runtime.

This is runtime resolution today, not a claim that every existing UI control or legacy tool has been automatically generated. A future generated convenience client or named tool should wrap the same definition rather than own its business logic.

## 3. Share behavior without erasing caller policy

One operation does not mean every caller has identical authority.

Resolve caller identity from the transport/session binding. Do not trust a caller-supplied session ID, attempt generation, or ownership token as proof of authority. Load the persisted task, session, and active execution identity when the operation needs them.

Caller-specific admission belongs in explicit policy stages or dependencies. For example, direct review submission admits the task's own persisted worker MCP session; approval follows the existing human/coordinator policy. Once admitted, callers use the same core mutation or durable dispatch stage.

Preserve current restrictions during migration. Do not introduce a new permissions framework merely because an operation becomes shared, and do not treat runtime discovery as authorization.

## 4. Use one direct pipeline per business operation

Compose named decision, transformation, and effect stages directly with Superpipe. Pure functions classify, validate, or prepare values; effect stages read state, commit changes, enqueue work, or emit notifications.

The objective is explicit composition and reusable rules, not to pretend that database writes or session shutdown are pure functions.

For typed rejection gates, use disjoint `{ value: T }` and `{ reason: Failure }` results. All rejection stages in that path must target the same final result output, such as `result:outcome`, so early exits preserve the intended result. Reuse exported stages directly rather than nesting pipelines that hide their effects.

Transactions, process handles, locks, and resource-owning loops remain ordinary owners where appropriate. They can consult pure gates or pipelines; Superpipe does not replace their atomicity or lifetime responsibilities.

## 5. Make composition explicit and instance-owned

The daemon composition layer supplies concrete repositories, managers, callbacks, and queue processors. Operation factories receive named dependencies rather than growing positional argument lists.

Use an instance-owned registry/provider. Resolve live configured dependencies lazily where necessary, preserving custom-provider precedence. Catalog discovery should not accidentally open sessions, touch an incompletely configured database, or execute task work.

Keep `app.ts` and RPC setup focused on assembling capabilities. Domain decisions belong in operations or domain services, not in transport registration code.

## 6. Separate domain state from execution mechanism

A task has its own lifecycle. A Space can own a task; a workflow can execute it. Neither relationship should make a workflow mandatory for every task operation.

Keep workflow-specific run/node behavior behind explicit execution dependencies or adapters. Direct-session execution reuses task rules and prompts without fabricating a workflow run. Do not assume that SDK idle means task completion: completion or review submission is an explicit operation.

Shared operations must still preserve execution ownership. Validate the exact attempt, worker session, generation, and current task pointer before acting. Workflow and direct execution must respect the same configured resource limits.

## 7. Distinguish immediate results from durable acknowledgements

An operation may return a completed synchronous result or acknowledge accepted background work. Its schema and description must make that distinction clear.

For long-running or self-interrupting actions:

1. Validate admission and freeze the canonical request.
2. Persist the request, required state/ownership change, and job linkage in one transaction.
3. Return a durable acknowledgement.
4. Let a registered worker perform session preparation, delivery, or shutdown.
5. Commit the resulting lifecycle transition with its ownership guards.

A worker submitting its own outcome must not await its own interruption inside the MCP call. A start acknowledgement means queued work, not a running SDK session. Message acceptance means durable mailbox persistence, not an agent reply.

Ordinary transport request/response association is separate from later agent messages and events. Do not add a conversation-wide correlation scheme just to unify the interfaces.

## 8. Preserve invariants across asynchronous boundaries

Freeze retry inputs, including rejection feedback. Do not rebuild an accepted request from mutable task metadata later. Stable request identities and persisted receipts make replay idempotent.

Distinguish temporary waiting from obsolete work. Paused Spaces, unmet dependencies, and occupied capacity can defer the same claim-fenced job without consuming its failure budget. Terminal or superseded requests need explicit settlement and safe cleanup; they must not loop forever.

Capture lifecycle generations when admitting work and revalidate at the actual mutation/activation boundary after awaits. A cancel-then-reopen sequence must not revive an old accepted request merely because the status has the same text again.

Capacity checks must be atomic with reservations and shared by all competing execution paths. Checking a limit before an asynchronous spawn does not reserve the slot.

Do not weaken shutdown proof to make retries pass. Missing cached process state is not evidence that an old worker exited. Automatic daemon-crash recovery remains a separately scoped capability in this stream.

## 9. Migrate incrementally without changing hidden contracts

Use this sequence for each action family:

1. Inventory RPC, MCP, internal callers, and their observable behavior: validation, scope, writes, events, audit, callbacks, and timing.
2. Preserve useful behavior with regression coverage; do not enshrine code scheduled for deletion.
3. Extract shared policy and field-preparation functions without behavioral changes.
4. Build one operation using those rules and explicit effect dependencies.
5. Route callers through it, retaining transport formatting and compatibility behavior.
6. Remove obsolete wrappers only after their callers have migrated.

Name behavior changes explicitly. If a legacy cancellation cascades to dependents while a new operation cancels one task, they are not interchangeable wrappers. If rejection now queues a fresh worker in `open`, descriptions must not promise immediate `in_progress` execution.

Each merge should be a usable checkpoint. Register consumers before exposing producers. Keep independent branches based on merged `dev`; do not stack on unmerged sibling implementations. Combine small coherent build/wire changes when appropriate, but separate unrelated cleanup or infrastructure.

## 10. Validate the contract, not just the helper

Useful CI coverage includes RPC/MCP semantic parity, caller scope, invalid inputs/results, idempotent replay, exactly-once effects, transaction rollback, stale claims, lifecycle changes during awaits, temporary waiting versus terminal cleanup, and a connected start-to-review-to-approval flow.

Validate observable results and effects. Avoid tests coupled to private methods or invented fixtures that violate real workflow/schema rules. Include failures and concurrency windows for the changed path without expanding into unrelated recovery infrastructure.

Workflow agreed for this migration stream (follow current repository and user instructions for other work): write necessary tests but run them in CI; run `bun run check` locally. No self-review or independent reviewer-agent passes. Merge only the exact head with completed GitHub Codex approval, green CI, and no unresolved substantive findings.

## Current implementation boundaries

Implemented foundations include the operation contract, shared invoker, RPC/MCP adapters, dynamic discovery, instance-owned catalogs, shared task metadata/dependency behavior, review submission, approval/rejection routing, durable outcome handling, and direct cancellation. Coverage and supported ownership types vary by binding; inspect the operation description and admission policy.

Not every legacy RPC or MCP wrapper has been removed or migrated. Shared `task.start`/retry exposure is still pending in [PR #4391](https://github.com/lsm/HyperNeo/pull/4391) at this snapshot, including fixes required to preserve workflow concurrency and start metadata. The guardian [PR #4367](https://github.com/lsm/HyperNeo/pull/4367) is parked and is not a prerequisite for the agreed first release. Do not describe the entire stream as complete until its final merge gates pass.

## Code entry points

Source entry points for agents working in HyperNeo:

- [packages/daemon/src/lib/operations/registry.ts](../../packages/daemon/src/lib/operations/registry.ts): operation and caller contracts.
- [packages/daemon/src/lib/operations/invoke.ts](../../packages/daemon/src/lib/operations/invoke.ts): shared resolve/validate/execute/result pipeline.
- [rpc-adapter.ts](../../packages/daemon/src/lib/operations/rpc-adapter.ts) and [mcp-adapter.ts](../../packages/daemon/src/lib/operations/mcp-adapter.ts): transport adapters.
- [discovery.ts](../../packages/daemon/src/lib/operations/discovery.ts) and [mcp-server.ts](../../packages/daemon/src/lib/operations/mcp-server.ts): runtime discovery/invocation.
- [packages/daemon/src/lib/operations/catalog.ts](../../packages/daemon/src/lib/operations/catalog.ts): common operation catalog.
- [packages/daemon/src/lib/space/operations/registry.ts](../../packages/daemon/src/lib/space/operations/registry.ts): configured Space capabilities.
- [packages/daemon/src/lib/space/operations/submit-for-review.ts](../../packages/daemon/src/lib/space/operations/submit-for-review.ts): concrete shared operation with persisted caller admission and durable acknowledgement.
- [packages/daemon/src/lib/space/runtime/direct-outcome-jobs.ts](../../packages/daemon/src/lib/space/runtime/direct-outcome-jobs.ts): durable outcome dispatch.
- [packages/daemon/src/lib/space/runtime/direct-start-jobs.ts](../../packages/daemon/src/lib/space/runtime/direct-start-jobs.ts): durable start execution.

When adding the next capability, ask: can both transports call one operation with trusted caller context, an honest result contract, and one authoritative implementation of its rules and effects? Implement that seam before expanding the architecture.
