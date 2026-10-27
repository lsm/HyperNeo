# Slow recording storage leaves phone voice RPCs responsive

Follow SKILL.md's shared isolation, cleanup and resource check. Use pinned Bun
1.4.2; no provider, model mock, real data, simulator or GUI is needed.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/voice-recording-writer.ts
```

The helper starts a synthetic daemon and loopback HTTP ASR on ephemeral ports.
It submits identical concurrent voice.transcribe RPCs and a replay, and refuses
changed audio under the same recording ID. All three successful replies must
contain the same transcript and the ASR must receive exactly one submission.
It models a 1.2-second executing-thread wait on the recording reservation INSERT.
An independent process probes system.health over WebSocket during the wait.
Every recording SELECT/INSERT/UPDATE must execute on a DB worker, and health
must stay below 250 ms. The tests-first baseline delays health about 1,209 ms.
observed.json records replies, ASR calls, health and executing-thread SQL evidence;
recording-sql.jsonl contains only synthetic SQL, without audio or message bodies.
Missing SQL evidence or RPC failure fails the proof. Resources close in finally
and the shared wrapper retains evidence and removes disposable data.

Also run the existing voice-recording-idempotency journey's full restart/kill
proof and preflight mode. They must still return the saved result after a lost
socket/restart, refuse an interrupted dispatched request without resubmission,
and allow pre-dispatch refusals to retry. Before each heavy helper run use the
shared resource check; stop owned processes and save evidence before deleting
the fresh run directory. This proves synthetic storage isolation and retry
semantics, not production lock attribution or a day of phone reliability.

The helper configures `disableWorktrees` on the daemon Config and awaits the job
processor's stop before creating fixtures. It does not rely on the unused
`disableGoalProcessing` setting. A disposable Git repo and explicit worktree
request through session.create must retain the original workspace and exactly
one Git worktree. observed.json records that RPC/Git evidence; the tests-first
reproduction instead created a second worktree inside the synthetic data dir.
Only after this isolation check does the voice/health proof begin.

The daemon must forward Config.disableWorktrees into SessionLifecycleConfig.
Moving the helper option alone is insufficient: the real session.create check
also reproduced a worktree when that forwarding was missing.

Cancellation-before-ASR regression (fresh evidence directory):

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/cancel-evidence .claude/skills/verify/voice-recording-writer.ts cancel-dispatch
```

This mode moves the 1200 ms worker wait to the durable dispatch UPDATE and
shortens only the parent proof's transcription deadline to 200 ms. It restores
the deadline before retrying. The first attempt must time out with zero ASR
requests; its reservation must remain undispatched. Identical concurrent retries
and replay then return one successful transcript with exactly one ASR call.
The normal 120-second timeout message is unchanged; the shortened deadline is
a synthetic fixture, not real elapsed production timeout evidence. observed.json
records the cancelled reservation and ASR count before retry. Both modes require
exactly one logged storage wait and keep client health under 250 ms. Once any
network submission may have occurred, restart/failure still refuses resubmission.
