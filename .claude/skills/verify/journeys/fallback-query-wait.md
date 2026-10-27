# Fallback proceeds when the prior SDK stream remains open

Use SKILL.md's isolated metadata-only proof wrapper and resource check:

```sh
bash .claude/skills/verify/proof-run.sh <absolute-fresh-evidence-dir> .claude/skills/verify/fallback-query-wait.ts
```

The helper starts an ephemeral real daemon and uses public message.send,
session.get and message.sdkMessages RPCs. Its scripted SDK consumes the original
human prompt, emits an ordinary top-level rate-limit result, then leaves its
stream open. The configured fallback must switch from Haiku to Sonnet and produce
FALLBACK_RECOVERED for that same prompt without another human message. The fixture
writes its own synthetic SDK transcript so normal resume validation still runs.
It refuses external HTTP and supplies its provider credential only in the fresh
DB; there is no model listener, credential file, browser, live daemon or port 8399.

On the baseline, the first result is persisted but the fallback is still awaiting
the old query promise after 15 seconds: only the first query starts, the model
stays Haiku, and neither interrupt nor close reaches the old query. The helper
fails its user-facing recovery assertion. Preserve that failing evidence before
changing the fallback path.

Require wrapper exit zero for the fix. Preserve fallback-query-wait.json, proof.log
and run-status.json. The helper closes the transport, synthetic SDK streams and
daemon in finally; the wrapper saves evidence and removes HOME/data immediately.
The online convo regression invokes the same helper in a scrubbed temporary home.
This verifies the RPC/SDK lifecycle with a scripted provider; upstream model
behavior, browser rendering and deployment remain unverified.

Repeat with --cancel before the run directory (the wrapper forwards arguments).
That case cancels through session.cancelRateLimitRetry while recovery is pending,
releases only the synthetic old stream, and requires the original model with no
fallback SDK start. It characterizes model/replay ownership; the observed stale
processing projection after this cancellation is a separate #9095 finding.
The scripted SDK requests the next prompt concurrently, as the real transport
does, so the queue can acknowledge the consumed input. Await the existing
post-settlement flush before cleanup; closed-database callbacks are not a pass.
