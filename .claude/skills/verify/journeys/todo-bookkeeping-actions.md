# Todo action bookkeeping does not veto an invocation

Use the shared isolated metadata-only setup and cleanup from SKILL.md:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/todo-bookkeeping-actions.ts
```

The production MCP door must return ok true with records for retrying a
nonretryable todo, continuing unstarted work, an invalid replacement, and
operations on a settled ask. A no-op leaves todos and human start cards
unchanged and dispatches no worker. Removal with a missing replacement still
removes the todo with its reason, without storing a dangling link. The migrated
operation audit stores five accepted records, preserved after DB reopen.
The baseline fails on the first not_retryable refusal. Save observed.json and
proof.log; the wrapper immediately removes synthetic data.

This proves tool receipts and durable metadata, with real operations, runner,
repositories and audit writes. It does not exercise HTTP/WebSocket, model turns
or GUI. The sibling work-todo-reference journey covers actual mailbox delivery
when a work call has no valid todo reference. Existing start-card, interrupted
start and stop-failure contracts remain required.
