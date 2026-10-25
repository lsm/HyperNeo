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
