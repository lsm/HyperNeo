# Human work in an existing worker reaches Neo

Use SKILL.md shared isolation and resource guard. Omit the fixed-port preflight: this helper owns an ephemeral loopback
model and redirects both title and session requests to its assigned port.
It owns a real daemon on an ephemeral non-8399 port. It creates fresh homes/databases and disables external registry MCP servers.
It disables the SDK sandbox only for the synthetic transport fixture, making no
OS-enforcement claim. Never use a live worker or copy a real database.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/neo-human-turns.ts verify
```

The tester submits human input through the public message.send RPC to a real
worker already bound to a completed todo on an open ask, with an adoption anchor
and no dispatch row. The real worker SDK replies through a loopback scripted
model. The real driver-refresh job must deliver the human input and final reply
to Neo. Neo's actual SDK/MCP tool call records new work as a todo on that ask.
Wait for Neo's final SDK result after the MCP tool callback before counting
requests: the tool-result continuation belongs to that same native turn.
Two repeated observations then add no model request or todo. Keep observed.json,
model-bodies.json and proof.log; require wrapper exit zero and clean shutdown.
This proves server/SDK/tools and persistent matter state, not real-model judgment.

On the test-only reproduction commit use mode before with the same helper:
worker completion is observed, but no report reaches Neo and no todo is added.
Run verify again from the merged build deployed into the isolated test daemon
before writing the final task result. A production restart is not part of this
journey. Unit contracts separately cover dispatch receipts, all todo states,
tracked history anchors and repeat observation. Retain both baseline and fixed
proofs; they are separate runs, not independent uses of a live human worker.

Settled-worker observations are deduplicated per worker/recipient and bounded to
20 per sweep, with round-robin continuation. The runner contract creates 21
completed workers, verifies 20 status reads in the first sweep and all 21 human
turns delivered after the next. There is no age cutoff: an older completed
worker can become active again while its ask remains open.
