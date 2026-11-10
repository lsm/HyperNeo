# Scoped front reads

Build web for the checkout, then run `neo-front-reads.ts` through `proof-run.sh`
with the pinned Bun runtime and the checkout head as its argument. The helper
starts an isolated daemon on an ephemeral port with a synthetic HOME and database.
It stops job processing before seeding records and uses the registered read gateway.

Require every project, ask, card and todo page to contain at most ten summaries,
with a full total and immutable-ID continuation. Editing an unseen record between
pages must retain every original record exactly once. Search must find the closed record
outside the first page, return details for a unique match, and count all ambiguous
matches before limiting candidates. The unit regression log also retains query plans
for full-text, one-character and tokenless reads over 5,024 projects, requiring FTS
indexes for terms and an indexed ID seek with LIMIT for tokenless continuation. The second status read must reflect a changed
todo. Unknown conversation scope must fail, and fast replies must remain off.

Retain `observed.json`, the proof log and the wrapper exit status. The four kinds
must report 31, 30, 30 and 30 listed records, and 30 search matches each. This proves
the internal read contract used by the later front integration.
