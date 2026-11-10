# Scoped front reads

Build web for the checkout, then run `neo-front-reads.ts` through `proof-run.sh`
with the pinned Bun runtime and the checkout head as its argument. The helper
starts an isolated daemon with a synthetic HOME and database, stops job processing,
and exercises the registered read gateway.

Pages visit at most ten candidates plus one lookahead. Creation time orders records
newest first, with immutable ID as the tiebreaker. Updates between pages must retain
every original record exactly once. Edit reader-visible names/text and assert the
new unseen projection, plus fresh details for the already-seen edited record. Totals are explicitly approximate whenever
`totalExact` is false. They report matches observed in this traversal. Callers must
follow `nextCursor` even when a search window contains no matches. Candidate IDs
support a fresh detail lookup. List and search always return paged summaries, even
for a unique match. Only `{id}` returns a detailed record. The durable conversation
record defines scope independently of the current coordinator binding. One- and two-character terms retain substring matches.
Empty or tokenless searches return no results.

The unit regression retains query plans and row counts over 5,024 projects. Require
an indexed `(created_at,id)` seek, no sorting scan, no aggregate count, and at most
11 returned candidates per statement. Long-term FTS probes must use a fixed row ID.

Retain `observed.json`, the proof log and the wrapper status. Traversals must produce
31 projects and 30 active asks, cards and todos in creation order, with 30 search
matches per reader. Verify a middle-of-word short substring, explicit estimate
flags, empty tokenless results, fresh todo status, invalid-scope rejection and the
default-off switch. The wrapper removes its temporary data after retaining evidence.
