# Scoped front reads

Build web for the checkout, then run `neo-front-reads.ts` through `proof-run.sh`
with the pinned Bun runtime and the checkout head as its argument. The helper
starts an isolated daemon with a synthetic HOME and database, stops job processing,
and exercises the registered read gateway.

Pages visit at most ten candidates plus one lookahead. Creation time orders records
newest first, with immutable ID as the tiebreaker. Each response declares
`forwardOnly: true`. These are live discovery windows. A rename into a search or a
reopened ask behind the cursor appears on a fresh read, rather than in continuation.
Restart list/search reads to discover membership changes behind an existing cursor.

This is appropriate for the front's advisory discovery surface. Use `{id}` for
current status. Defer absence and exhaustive-current-set claims from continued
windows to Neo. Following a cursor to its end establishes traversal completion,
not a snapshot of membership at the end. `totalExact: false` reports matches observed
in this traversal. Follow `nextCursor` even when a window contains no matches.
List/search always return summaries, including unique matches. Only `{id}` returns
details. The durable conversation defines scope independently of coordinator bindings.
One- and two-character terms retain substring matches. Tokenless searches are empty.

Membership-preserving edits must retain each discovered ID exactly once. Edit visible
names/text and assert the unseen projection plus fresh details for the already-seen
record. Membership-changing regressions must show a renamed project and a reopened
ask absent from continuation, present after restart, and current by ID.

The unit regression retains query plans and row counts over 5,024 projects. Require
an indexed `(created_at,id)` seek, no sorting scan, no aggregate count, and at most
11 returned candidates per statement. Long-term FTS probes must use a fixed row ID.

Retain `observed.json`, the proof log and the wrapper status. Traversals must produce
31 projects and 30 active asks, cards and todos in creation order, with 30 search
matches per reader. Verify a middle-of-word short substring, explicit estimate
flags, empty tokenless results, fresh todo status, invalid-scope rejection and the
default-off switch. The wrapper removes its temporary data after retaining evidence.
