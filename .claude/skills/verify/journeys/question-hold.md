# The human holds a card and takes it back

Use the shared in-process RPC proof setup in SKILL.md with
`PROOF=.claude/skills/verify/question-hold.ts`. No provider turn, HTTP model
mock, or 8000/8001 preflight is needed.

The helper owns a real daemon on an ephemeral port and a fresh synthetic DB.
It seeds one ask, one todo and one open card on that todo, then drives
`neo.question.hold`, `neo.question.get`, `neo.question.answer` and
`neo.snapshot` over actual WebSocket RPC as the local user.

The open card makes `needsYou` 1. Holding it sets `heldAt` and drops
`needsYou` to 0; holding again returns the same `heldAt`. Taking it back
removes `heldAt`, twice. Replaying the first hold's `requestId` after that
changes nothing, and `needsYou` is 1 again. Answering a held card
works and the answered card has no `heldAt`. Holding an answered card is
refused with `question_closed`.

`evidence/observed.json` keeps every RPC reply; `evidence/cleanup.json`
confirms owned daemon cleanup. This proves the operation and the snapshot
count, not any client button, which later steps add.
