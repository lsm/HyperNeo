# A subscribed PR closure missing from history is discovered

Use shared isolation in `../SKILL.md`:

```bash
RUN=$(mktemp -d /private/tmp/hn-unrecorded-closure-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-unrecorded-closure.ts "$RUN"
```

The helper owns an ephemeral daemon, loopback GitHub fixture and refusing/proxy
gh stub. The public poll RPC sees an old open observation, an unchanged head,
and a saved ETag, but no recorded closure. Open, incomplete, failed and 304
responses leave subscriptions intact. A full closed detail records one canonical
terminal event. One mailbox rejects; both subscriptions remain until restart
and recovery finish acceptance. Re-registration cannot duplicate receipts or
jobs. A newer recorded open state suppresses an older discovered close.

Inspect `evidence/unrecorded-closure.json`, `requests.json` and the captured log.
Full detail bodies replace conditional detail requests only for exact session
subscriptions; no extra endpoint is introduced. Canonical history is preserved.
Jobs are deferred before restart and the processor is stopped, so this proves
queue acceptance rather than worker consumption. Card acknowledgement stays
separate. No model, real GitHub, keys, auth files, live DB, GUI or port 8399.
All owned daemon, WebSocket and fixture resources stop in finally.
