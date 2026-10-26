# Build read-only mutation planning (#8712 core 1a)

Use SKILL.md's guarded metadata-only wrapper with fresh absolute evidence
paths. Run from the task checkout; reuse installed dependencies.

```sh
bash .claude/skills/verify/proof-run.sh "$BEFORE_EVIDENCE" .claude/skills/verify/todo-mutation-planning.ts before
bash .claude/skills/verify/proof-run.sh "$AFTER_EVIDENCE" .claude/skills/verify/todo-mutation-planning.ts verify
```

The before run reproduces the missing registered planner on unchanged dev.
The fixed run sends cloned input through the daemon's real reader worker,
then reads the actual full card through the existing `neo.ask.read` WebSocket
operation. The helper's dispatch stub throws if accidentally run inline on main.
No test-only RPC, provider turn, external command or network endpoint is added.
The synthetic fixture has an open human card, two todos and a large Unicode
report; it never copies a live database.

Pass requires a title/URL proposal to preserve current peer-ownership
bookkeeping, and a core-check proposal to derive its label without observing
external completion facts. Remove is also only a proposal. The public full card
must keep its original title, open human card and entire stored report/hash.
Planning must emit no `neo.changed` event and execute no todo SQL on main.
`todo-mutation-planning.json` records the result and `resourcesStopped` after
cleanup; the wrapper saves it before deleting temporary HOME/data/TMPDIR.
The required Deno smoke invokes the same helper and prints its JSON before
shared fixture cleanup. Deno not installed locally is unverified until that
required job succeeds; do not fabricate a Deno evidence report.

The inline gateway unit contracts additionally cover settled-ask successful
no-op receipts, invalid/missing/removed work, full proposed reports, artifact
reference validation, explicit check replacement and URL bookkeeping. Every
plan is compared with the unchanged stored card/todos and `total_changes()`.
Run the planner, core-check, todo-input and bookkeeping suites through daemon
Vitest, plus the full repository check.

This is an advisory build, not authorization for a future mutation. Slice 1b
must re-run planning and all final check/card/ownership reads in the same writer
transaction as the state change. Slice 1c activates runtime mutation callers
only after that build merges. No external completion check, stop, dispatch or
write is run here; existing mutation operations remain on their current paths.
The commit-before-reply and unknown-outcome contracts remain unchanged.

This read-only slice does not measure the contended affected-write target.
The later diagnostics slice must report a missed target without early success,
replay or a durability change. GUI layout, real provider execution and runtime
mutation activation are not verified by this journey.
