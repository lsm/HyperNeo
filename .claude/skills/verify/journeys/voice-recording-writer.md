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
