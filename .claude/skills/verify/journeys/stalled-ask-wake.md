# Stalled asks receive a bounded reminder

Use the shared metadata-only isolated setup in SKILL.md. No model, provider,
GUI or external service is needed. Set PROOF to
`.claude/skills/verify/stalled-ask-wake.ts`, create a fresh RUN and execute it
under `env -i` with NODE_ENV=test, a private HOME and HYPERNEO_DATA_DIR.

The helper starts an isolated daemon on an ephemeral non-8399 port. It seeds
synthetic open, settled and questioned asks, then invokes the production
one-minute refresh handler with a fake clock. Its ordinary mailbox receipts
must show no wake before two hours, one wake for the stalled ask at two hours,
no wake for settled/questioned asks, no duplicate from overlapping refreshes,
and a repeat only after four more hours. It restarts its own daemon once and
checks that the cooldown survives. The note names its ask and says:
“This ask has nothing in progress. Add the next todo, or settle it.”

Retain `evidence/result.json` and daemon output. The unit contracts additionally
cover waiting/doing/blocked/done todos, a recent ask and failed handoff retry.
The observable endpoint here is durable mailbox admission, not model receipt;
no provider turn or live-daemon behavior is claimed. Both daemon instances are
closed in finally.
