# The snapshot lists what waits on the human, with each todo's owner

Use the shared in-process RPC proof setup in SKILL.md with
`PROOF=.claude/skills/verify/human-queue.ts`. No provider turn, HTTP model
mock, or 8000/8001 preflight is needed.

The helper owns a real daemon on an ephemeral port and a fresh synthetic DB.
It seeds two asks: one with a card on one todo, a todo with no worker and a
todo that depends on it; the other with a card the human holds through
`neo.question.hold`. It reads `neo.snapshot` over actual WebSocket RPC as the
local user.

`humanQueue.items` lists the waiting card with its todo, the held card, and
each uncovered todo as in progress: the one with no worker is Neo's step, the
dependent one is its prerequisite's. A todo under a card is not listed again.
`humanQueue.counts` gives waiting, held and progress per ask.

`evidence/observed.json` keeps every RPC reply; `evidence/cleanup.json`
confirms owned daemon cleanup. This proves the snapshot field, not any client
view, which later steps add.
