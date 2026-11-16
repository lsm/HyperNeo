# Stalled and finished asks reach Neo through the attention entry

Use the shared metadata-only isolated setup in SKILL.md. No model, provider,
GUI or external service is needed. Set PROOF to
`.claude/skills/verify/stalled-ask-wake.ts`, create a fresh RUN and execute it
under `env -i` with NODE_ENV=test, a private HOME and HYPERNEO_DATA_DIR.

The helper starts an isolated daemon on an ephemeral non-8399 port and binds a
synthetic Neo session. It seeds open, settled, questioned and blocked asks,
then invokes the production one-minute refresh handler with a fake clock. An
open ask with no todo left is one digest line (`neo_notes`) at two hours, not
before; overlapping refreshes and a daemon restart add nothing; it repeats
once, a day after the ask last changed, and never again. Settled and
questioned asks are not told, and neither is an ask with a blocked todo: that
todo raises its own step. The line names its ask and says:
“This ask has nothing in progress. Add the next todo, or settle it.”

An ask whose todos all finished wakes Neo at once instead (`mailbox`), with
“All todos are finished: write the outcome with neo.ask.settle, or add the next
todo.”; writing the outcome afterwards does not wake again. The helper also
requires `neo_asks` to have no `stalled_wake_at` column.

Retain `evidence/result.json` and daemon output. The unit contracts in
`neo-stalled-asks.test.ts` additionally cover waiting/doing todos, a recent
ask, an open child ask, archived/deleted ask sessions and a failed tell being
made again. Neither a failed tell nor a failed query may block session
watching; a watcher failure must not suppress the note.
The observable endpoint here is durable queue admission, not model receipt;
no provider turn or live-daemon behavior is claimed. Both daemon instances are
closed in finally.
