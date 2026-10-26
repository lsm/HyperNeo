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

Automatic input for active and completed targets must return a native queue ID,
delivered false and no receipt before consumption. It must make no Desktop
ownership request, open, resume, steer or turn/start call. The synthetic receiver
then becomes idle and consumes that same queued input exactly once. work.status
must show the matching input and reply; queue acceptance alone is not delivery.
Explicit steer still returns its confirmed active turn ID; a known refusal must
not also enqueue. New-thread creation retains its Desktop handoff.
The queue fixture then explicitly rejects an input with the typed active-writer
precondition response. work.send must return notSent true so callers can retry.
A later queue request loses its acknowledgment after dispatch: that response
must remain uncertain, without notSent or a second queue submission. Explicit
steering retains the same distinction between pre-send failure and a lost reply.

The failing reproduction is committed before the fix: the unchanged adapter
steers instead of returning a queue ID. Retain observed.json, proof.log and
run-status.json for red and green runs. The wrapper removes disposable daemon
data after saving evidence.

This proves daemon routing and transcript reporting with a synthetic receiver.
It does not prove native Desktop queue consumption or rendering. After merge,
read hyperneo build and confirm the served commit contains the squash commit.
Never restart the live daemon. Neo must arrange any live disposable-thread
consumption and human Desktop confirmation; do not use working threads.

Also run the Codex IPC contract suite alongside the adapter, verbs and handoff
suites. Its operation-schema check uses explicit mode steer; automatic sends
must retain queue receipts with missing/stale IPC and refused/hung launchers.
