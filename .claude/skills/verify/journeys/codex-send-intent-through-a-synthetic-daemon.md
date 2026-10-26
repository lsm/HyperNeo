## Codex send intent through a synthetic daemon

Use the shared resource guard, isolated HOME/data setup and evidence cleanup in
SKILL.md. From the worktree root, run:

```bash
TMPDIR=/absolute/writable/temp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence .claude/skills/verify/codex-send-intent.ts verify 9377
```

Choose a free non-8399 port. The helper starts an isolated daemon and synthetic
Codex Desktop IPC/app-server sockets. It invokes production work.send and
receipt-bound work.status over real WebSocket operation.invoke. No credentials,
model, real Codex state or GUI is involved.

Automatic input routes by Desktop ownership. While the synthetic Desktop peer is
running, an automatic send must deliver through the owner client — owner
discovery, opening an ownerless thread once, then follower steer, or follower
turn start after a no-active-turn refusal — and must never call the app-server
`thread/resume` or the native queue. With the Desktop probe reporting not
running, automatic input for active and completed targets must return a native
queue ID, delivered false and no receipt before consumption, and make no
Desktop ownership request, open, steer or turn/start call. The app-server
loaded list is checked before settings or queue calls; only a saved, unloaded
thread is resumed.
The stateful peer rejects settings and enqueue requests until that resume succeeds.
The proof supplies a synthetic prepared-worker policy at the sandbox seam, so it
does not require or prove OS runtime-directory permissions. The synthetic receiver
then becomes idle and consumes that same queued input exactly once. work.status
must show the matching input and reply; queue acceptance alone is not delivery.
Explicit steer still returns its confirmed active turn ID; a known refusal must
not also enqueue. New-thread creation retains its Desktop handoff.
For marked prepared workers, queue dispatch must first recreate private runtime
directories purged during idle time. Focused filesystem checks remove the actual
worker runtime, invoke automatic send, and observe the directories at both native
queue dispatch and CLI fallback. They also check that routine queue routing logs
`native_queue`, without implying that a steering attempt failed. These checks do
not start another writer or prove OS containment; use the worker-sandbox journey
for that separate boundary.
The queue fixture then explicitly rejects an input with the typed active-writer
precondition response. work.send must return notSent true so callers can retry.
A later queue request loses its acknowledgment after dispatch: that response
must remain uncertain, without notSent or a second queue submission. Explicit
steering retains the same distinction between pre-send failure and a lost reply.
Two overlapping automatic submissions then share a long prefix, and another pair
uses identical messages. Both queue calls take their pre-consumption snapshot
before the receiver writes only the first input and reply. Run both normal and
reversed receiver arrival orders for each message pair. Identify results by
their returned queue IDs and submitted client input IDs, never Promise.all
position: invocation order does not determine which call reaches the queue first.
The first consumed submission
may return that receipt only when its client input ID and complete message match;
the second must remain accepted with its own queue ID and no receipt. Its
matching text cannot borrow the first exchange. Receipt-bound work.status must
still show the first submission's own reply. A synthetic CLI fallback appends
an unrelated matching input while accepting a queue request: that route returns
only the queue ID and delivered false, because it has no correlated input ID.

The failing reproduction is committed before the fix: the unchanged adapter
returns `not_delivered` with `thread/settings/update: thread not found` for the
unloaded prepared worker. The fixed run observes that worker's matching reply
after one enqueue. Disconnects at loaded-list, resume and settings must name
the failed step, return typed `not_delivered` with `notSent: true`, and never enqueue.
Retain observed.json, proof.log and
run-status.json for red and green runs. The wrapper removes disposable daemon
data after saving evidence.

This proves daemon routing and transcript reporting with a synthetic receiver.
It does not prove native Desktop queue consumption or rendering. After merge,
read hyperneo build and confirm the served commit contains the squash commit.
Never restart the live daemon. Neo must arrange any live disposable-thread
consumption and human Desktop confirmation; do not use working threads.

Also run the Codex IPC contract suite alongside the adapter, verbs and handoff
suites. Its operation-schema check uses explicit mode steer; automatic sends
must retain queue receipts with missing/stale IPC and refused/hung launchers
when Desktop is not running, and owner delivery when it is.
