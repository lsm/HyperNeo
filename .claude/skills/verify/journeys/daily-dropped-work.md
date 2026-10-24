# Daily dropped-work counts reach the human

Read shared SKILL.md and use its metadata-only isolated setup with
PROOF=.claude/skills/verify/daily-dropped-work.ts. Use a fresh RUN, env -i,
NODE_ENV=test, its own HOME/data/database and ephemeral non-8399 ports.
No model, GUI, provider keys or external network is needed.

The helper seeds synthetic core facts plus a coding ledger ready item, and
invokes the existing pack sweep handler with a fake clock. Only external pack
acquisition is stubbed: the actual coding stats hook reads its cached ledger.
The actual conversation WebSocket RPC must return one daily publication with
separate core and coding counts. Overlapping sweeps send once. Restarting this
helper's daemon must preserve today's receipt; tomorrow adds a new message and
retains the previous counts unchanged. Both instances close in finally.

Keep evidence/result.json and daemon output. The unit contracts also cover
inactive packs, recent waiting work, a reported/running/unknown worker and a
new head resetting the ready duration. Existing coding ledger contracts pin
head-specific review and CI classification. This proves the backend and its
existing human-conversation API, not new UI rendering or live-daemon behavior.

CI publication-path control: run `HYPERNEO_TEST_DISABLE_SANDBOX=1 bash
.claude/skills/verify/publication-reader.sh <fresh-run-dir>`. This runs the real
SDK with synthetic model responses and then the web reader contracts, without
driving a GUI. Exactly one daily card must coexist with the scheduled wake and
the single authored reply. The daemon still has only one publication writer.
