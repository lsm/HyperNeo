# An ask whose wake turn ended settles itself

Use the shared metadata-only isolated setup in SKILL.md. No model, provider,
GUI or external service is needed. Set PROOF to
`.claude/skills/verify/ask-auto-settle.ts`, create a fresh RUN and execute it
under `env -i` with NODE_ENV=test, a private HOME and HYPERNEO_DATA_DIR.

The helper starts an isolated daemon on an ephemeral non-8399 port and seeds
four asks on one synthetic session: one with a finished step, one with no
steps, one with a live todo and one with an open card. It records a completed
neo_notes wake for each and the consumed batch user message plus the terminal
result row that together prove Neo's reminder was consumed in a turn that has
ended, then invokes the production one-minute refresh handler once.

After the refresh the finished ask is `done` with the generated sentence
"Finished Ship the slice.", the empty ask is `dropped` with "No steps
recorded.", and the asks with a live todo or an open card remain `open`. Had
Neo written an outcome the row would carry that instead, and a wake whose
turn has not ended — or was never delivered — settles nothing; the unit tests
in `neo-ask-turned-settle.test.ts` cover those cases, the direct-mailbox wake
shape, mid-turn consumption and per-ask isolation.

Retain `evidence/result.json` and daemon output. The observable endpoint here
is the settled `neo_asks` row after one real `refreshDriverWork` tick; no
provider turn or live-daemon behavior is claimed. The daemon is closed in
finally.
