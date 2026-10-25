# Quiet reports are history without Neo turns

Use the in-process RPC setup in SKILL.md with
`PROOF=.claude/skills/verify/neo-quiet-wake.ts`. Preflight port 8000; this helper
uses no port 8001. It starts a real isolated daemon on an ephemeral port and
its own loopback Anthropic SSE model on 8000. The SDK sandbox is disabled only
inside this synthetic transport proof; no OS sandbox enforcement is claimed.
No provider key is inherited. A synthetic provider is registered through RPC,
external registry MCP servers are disabled, and the helper installs a refusing
GitHub stub. All owned resources close in finally.

The synthetic Codex rollout has a task_complete final message consisting of
exactly a heartbeat envelope. The actual Codex adapter reads it and exposes
notify:false. The actual todo runner and NeoService record its unchanged report
as consumed SDK history, without a mailbox job or model request. A second
synthetic turn is linked to a focused discussion; the daemon's own status report
is likewise recorded without a turn. After each, wait 1.5 seconds and assert zero
model requests. Submit a human message over the real neo.message.send RPC;
observe exactly one model request and one persisted SDK result. Evidence lives
in evidence/observed.json and proof.log in the fresh run directory.

This proves the daemon/SDK path, not GUI rendering, real Codex automation
execution, real-model reasoning, or a production rollout. A synthetic work.status
source supplies turn ends to the real runner; the Codex heartbeat itself is read
from a synthetic rollout by readCodexTurn. Run the adapter verbs, note-delivery,
todo-runner, question-answer, human intake and PR-event unit contracts as well.

For an old-code reproduction, run the same helper with `--reproduce` as its
second argument against the pre-fix production files. It retains
`evidence/reproduction.json` and fails when the heartbeat starts a Neo model
turn. The fixed code's normal run must retain the 0/0/1 result above. Model
request evidence distinguishes the coordinator's operations tool from the
separate title-generation request; only one coordinator request and one SDK
result count as the human's turn.


## Quiet retry during urgent delivery

The helper then pauses only its isolated daemon's job processor. It delivers an
urgent report, retries that exact ID with a status-only kind both while delivery
is pending and after its mailbox job is queued, and records overlaps.json.
Each must have zero premature history rows and exactly one mailbox job. After
resuming that owned processor, each urgent report must produce exactly one Neo
turn and one history row. The original quiet/quiet/human result remains 0/0/1;
these two additional urgent reports bring the final SDK result count to three.
The note-delivery unit tests cover both quiet kinds, plus ten concurrent quiet
retries yielding only one stored row and zero jobs. Against the prior reviewed
head, the same helper fails the overlap assertion and retains overlaps.json.


## Quiet history uses the DB writer

Before delivering worker turn ends, the helper makes only the isolated daemon's
main connection read-only, after observing the startup body-copy completion
marker so that setup cannot interrupt its background migration. Ten concurrent retries of each quiet kind must still
persist exactly one history row through the DB writer and produce zero Neo
turns. The main connection is restored in finally. Retain readonly-quiet.json;
the prior head fails with a read-only database error. Also run the
sdk-message-gateway-routing unit suite, including its typed writer inventory.

## Hoisted dependency layout

Run `bash .claude/skills/verify/neo-quiet-wake-hoisted.sh "$RUN"` with a fresh,
absolute run directory. This wrapper temporarily exposes zod at the worktree's
root node_modules and moves its nested daemon entry aside, restores both on
EXIT, and executes the same isolated-daemon proof. It owns only these worktree
dependency entries. Shared environment and isolation rules remain in SKILL.md.
Retain layout.txt, proof.log and observed.json. The prior helper fails at module
load in this layout. The helper must also pass under the normal isolated linker,
where zod is present only beside the daemon sources, by using the daemon's
registered work.status schema instead of importing a package installation path.
