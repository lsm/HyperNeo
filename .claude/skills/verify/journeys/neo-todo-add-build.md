# Whole todo-add writer construction (#8712)

Use SKILL.md's guarded metadata-only wrapper with existing dependencies and a
fresh absolute evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/todo-add-build.ts verify
```

The helper owns an isolated daemon, reader/writer workers and real WebSocket
public `neo.ask.read` requests. No model, browser, native worker, external HTTP,
credentials, live database or port 8399 is used. The writer is exercised directly
through the daemon gateway; public add/open callers remain unchanged in this
construction slice. Do not claim runtime activation or completion of #8712.

Require the entire instruction in the receipt and opened Work card, including
its byte length and hash. A late start-question insert failure must roll back
the todo, target, ask stamp and notifications. Concurrent additions must join
one start card with every todo selected. Start returns only an intent, with no
worker dispatch or start card.
Invalid checks stay quiet. Repeating the same committed todo ID must fail rather
than create another card. Worker failure before dispatch must reject without a
main fallback. Losing a committed worker reply must report outcome unknown;
the public reader must find exactly one todo and an explicit repeat must fail.
Unit coverage also checks settled-ask no-change receipts, current PR-peer
bookkeeping and child-ask rollback.

The main-SQL guard wraps cached statement execution before startup, proves its
canary fails, and requires zero target SQL during writer jobs. Hold a synthetic
WAL lock for 1.2 seconds: no receipt or mutation notification before release;
health and the public card must still answer. Report affected duration against
250 ms separately from health and max loop lag. The held write necessarily
misses that target. RSS/WAL are end samples; phase timings and peaks are unverified.

Run focused add/PR-admission regressions and full repository checks. Deno smoke
registers the same helper; local Deno is unverified if unavailable. Retain
todo-add-build.json, proof.log and wrapper exit status. Require exit zero and
clean worker/daemon shutdown; a PASS assertion before a shutdown failure does
not count. The wrapper removes temporary HOME and database after saving evidence.
