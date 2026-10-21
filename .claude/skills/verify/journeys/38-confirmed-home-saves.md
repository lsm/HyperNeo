### Confirmed home saves (journey 38)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-home-confirmed-save.ts <port> "$RUN" after`.
The helper seeds only a synthetic Git identity/ask/history in its own HOME and
DB, then uses real question ask/get/answer and home init/save RPCs. Missing,
open, no, wrong-path and wrong-hash confirmations must refuse without changing
HEAD or either file. A matching human yes must commit the exact mandate bytes
and append to its sibling decisions.md in one commit with the question trailer.
Root direction uses root decisions.md; focused contracts cover that path too.

The helper records question/get's answeredByHuman flag, both committed paths,
contents and trailer. An unchanged retry adds no decision. Removing only the
synthetic Git identity forces commit failure: both prior files and HEAD must
remain identical, the index clean, and configuring identity makes retry succeed.
Evidence: `evidence/neo-home-confirmed-save-after.json`. On the test-only commit,
use `before` in a separate fresh run to retain the matching-human-yes refusal.
No provider/model, real credentials, GitHub request or GUI is exercised. Stop
with `stop.sh`. Direct filesystem write restrictions still belong to the
surrounding environment; this verifies the single operation, not a shell sandbox.
