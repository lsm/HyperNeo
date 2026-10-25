# Owned queued input withdrawal admits on the writer

Run lane-b-owned-input-withdrawal.ts under Bun or Deno in a fresh synthetic run,
with env -i, NODE_ENV=test, HOME=<run>/home and HYPERNEO_DATA_DIR=<run>/data.
The helper owns an ephemeral daemon and manual session, stops its own processor,
and sends real work.queue and work.withdraw operations over WebSocket RPC.
No provider, HTTP mock, GUI or model turn is required.

The main connection rejects all withdrawal admission SQL. An unclaimed queued
input must become withdrawn and remain idempotent on retry. A second input is
materialized as a synthetic deferred SDK row with a completed mailbox job; the
real cached-session removal path must remove the row and commit its withdrawal
tombstone. Health remains usable. Before the fix, RPC fails at the main lookup.

Evidence is evidence/owned-input-withdrawal.json. The helper closes its own
transport and daemon, then deletes its data, home and workspace after saving JSON.
Unit tests preserve wrong-owner and wrong-target rejection, completed/dead/processing
rules, activation races, interrupted removal retries and rollback of a failed final
tombstone. Writer-wait tests change the claim or sender before admission; a worker
failure must propagate without inline fallback. The reply contains only compact
removal identity, and deferred-removal callbacks run after the admission commits.

Other channel admission, queue recovery/reclaim, uncached-session removal, UI and
contention/performance targets are outside this journey.
