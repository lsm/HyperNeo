# Build the data-only runner command (#8712 core 2a)

Use the shared guarded metadata-only wrapper from SKILL.md with existing
dependencies and a fresh absolute evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/todo-runner-state.ts verify
```

Before the build, this same proof fails because the registered runner command
is absent. The fixed proof executes only the internal writer command against a
synthetic database. It observes complete Work cards through the real
`neo.ask.read` RPC. Runtime callers stay unchanged until 2b.

Recomputation must reuse commitState inside one transaction. An injected late
ask-stamp failure must leave the public card and start question unchanged,
without table notifications. A held WAL lock must produce no early receipt or
notification while health/read RPCs remain responsive. After release, the
receipt preserves the entire Unicode report and returns only a successor
candidate; no work is started.

Two competing start claims must yield one winner. The winner uses the current
stored target, atomically relocates the todo to its repository card, and
returns the committed todo/ask/target without opening a worker. A pruning-only
change must set `changed` and announce the question table; unchanged/missing
state work must stay quiet. No Neo event or runtime dispatch occurs in this
build rung, and no todo admission/state SQL runs on main.

Unit cases additionally cover stale completion checks, adopted targets,
settled asks and rollback during a claim. Run them with the existing state
writer, runner, repository-selection and pack-boundary contracts, plus the full
check. The required Deno smoke invokes this same helper; local Deno remains
unverified if not installed. The helper stops its daemon in finally and writes
`todo-runner-state.json`; the wrapper saves evidence then removes the temporary
HOME/database. This correctness proof makes no latency-target, GUI or real
provider claim.
