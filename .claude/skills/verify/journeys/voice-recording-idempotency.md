# Retry batch voice uploads without duplicate ASR work

Run from the worktree root, with a fresh absolute run directory and free ports:

```bash
bash .claude/skills/verify/voice-recording-retries.sh "$RUN" 9437 9438
```

The helper launches a NODE_ENV=test CLI daemon with env -i, synthetic HOME/data
and DB, a gh stub and a local HTTP ASR fake. It never uses keys, the real ai0,
the live DB, port 8399 or the phone. All owned services stop on exit.

It uploads a synthetic 217.9-second PCM16 WAV through public voice.transcribe
RPC, drops the phone WebSocket after the fake ASR receives the request, reconnects
and retries concurrently using the same recordingId. Both retries and the next
replay return the first result, with exactly one ASR submission. Different audio
under that id refuses. A normal daemon stop/restart still returns the saved
result. A terminal ASR failure is likewise replayed without resubmission.
Finally it holds an ASR response, SIGKILLs only its own isolated daemon after
submission, restarts it, and observes two unconfirmed refusals with no additional
ASR call. This is a real process interruption, not a seeded reservation.

End state: evidence/initial.json, restarted.json and interrupted.json document
one successful ASR call, one independent failed call and one interrupted call
(total three). The retained database contains their durable reservations;
there is no stored audio in the new table. Helpers retain synthetic source WAV
fixtures outside the database. The fake's processing delay is short: this tests
long recording size and lost responses, not real ASR processing latency.

Protocol for iOS: voice.transcribe accepts optional recordingId (UUID). Generate
it once per recording and retain it with the identical WAV bytes across retries,
connection changes and response timeouts. Matching paired-device retries join
live work or replay the stored terminal result; separate devices cannot retrieve
each other's cached transcripts. Id case is normalized. A dispatched row
without a live job is explicitly unconfirmed and will never auto-submit again.
Post-dispatch outcomes do not expire into re-execution. Preflight busy/rate/setup/
credential/endpoint failures allow same-id retry; their reservations remain,
and dispatch is claimed durably immediately before fetch, after endpoint lookup. Legacy requests
without recordingId retain their prior behavior and cannot be deduplicated.

The daemon's existing total batch deadline is 120 seconds; coordinate iOS to use
a response timeout above that (proposed at least 180 seconds) and retain the id.
This does not implement stream resume or connect stream.stop's implicit batch
fallback to a future recording-level stream protocol. It does not prove the
incident's exact cause or phone/Tailscale behavior; those need client evidence.

Preflight-refusal recovery proof (fresh directory, ports distinct from any other run):

```bash
bash .claude/skills/verify/voice-recording-retries.sh "$RUN" 9447 9448 preflight
```

This mode first refuses disabled voice, then repairs settings and succeeds with
that same id. While one batch runs it refuses a second recording as busy; after
the slot clears the same second id succeeds and replays its result. Finally an
endpoint-policy refusal is repaired without changing id. Exactly four ASR calls
serve those four successful recordings; the preflight refusals make none.
Evidence is evidence/preflight.json. Unit contracts also cover rate-window and
credential failures plus competing handler dispatch CAS. No rows or audio are
deleted to release preflight attempts. The default journey still proves that
post-dispatch failures and process interruption never resubmit.
