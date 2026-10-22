## Delivery admission after a spent query and deploy restart

Shared isolation rules are in SKILL.md. Run from the worktree root with a fresh
absolute run directory. Both modes use an isolated test daemon, real SDK and
ephemeral loopback model server. The helper pins the SDK subprocess endpoint to
that loopback fixture, without replacing its transport. Provider credentials
exist only in the synthetic DB, GitHub is stubbed, and the live daemon is never
called. Browser rendering and real providers are not exercised.
The ordinary fixture pre-seeds an Anthropic provider record to cover CI's
already-configured state. Setup lists providers and uses create/update RPC as
appropriate, storing the synthetic credential in the run's DB. Evidence records
`providerSetup`; the same proof works with a new or existing provider.

### P0a: bounded admission (CI acceptance)

`bash .claude/skills/verify/spent-admission-restart.sh "$RUN" deadline`

Ordinary-session control and Neo first consume a kickoff. The helper stops only
its daemon, marks that synthetic input pending for recovery, queues a system
input with origin `space_inject` plus four more inputs, then restarts against
its own DB/SDK history. Neo's head reaches `query_ready` while the session becomes
idle. `client.interrupt` must preserve the queued inputs. With the existing
admission timeout configured to 3000 ms, the head must log `slot_released` with
outcome `pending` between 2500 and 6000 ms. The ordinary control must deliver all
markers to actual model requests. This is P0a's acceptance, not full Neo delivery.

### P0b: full restart delivery (known red, outside CI)

`bash .claude/skills/verify/spent-admission-restart.sh "$RUN" full`

The default mode is also `full`. This separately selected reproduction is under
`tests/reproductions/`, outside CI's online/unit discovery; it is not skipped,
quarantined or marked flaky. It uses the same fixture and still requires every
queued marker to reach actual model requests and every row to become consumed,
without another restart or send. Until P0b (#8091), Neo fails with
`queued inputs did not reach the model after restart`, even though P0a releases
the admission on time. Never count the deadline-only mode as this gate passing.
P0b must turn this proof green and bring its full acceptance into CI.

Evidence is `$RUN/evidence/spent-admission-{ordinary,neo}.json`, recording the
acceptance mode, RPC receipt, lifecycle events, timestamps, row statuses and
model receipts. Both modes close daemon/SDK, WebSocket and model server in
finally. Reproduction commit `0a0166c0d3` precedes the production deletion:
`/tmp/hyperneo-spent-admission-red-5/evidence/spent-admission-neo.json` shows an
idle Neo holding its `query_ready` admission beyond 20 s with a 3000 ms deadline.
The deletion-only full run remains red at
`/tmp/hyperneo-spent-admission-delete-only-1/evidence/spent-admission-neo.json`;
its admission releases at 3003–3004 ms, but queued markers do not reach the model.
