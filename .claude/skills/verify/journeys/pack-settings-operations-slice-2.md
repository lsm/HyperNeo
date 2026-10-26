### Pack settings operations (slice 2)

```bash
RUN=$(mktemp -d /private/tmp/hn-pack-settings-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/pack-settings-operations.ts 9352 "$RUN"
```

The real isolated daemon's WebSocket `operation.invoke` door must show unanswered
review-policy settings (apart from the explicit empty Coding watch list), accept a valid human write, refuse an invalid enum, and return the
saved value/provenance in get, list and `neo.snapshot`. The real MCP adapter over
the daemon's registry must refuse Neo's attempted policy change with `forbidden`
and still allow reads. Restart preserves the saved value, and an unknown repo
stays unanswered. `evidence/observed.json` retains every response. Both instances
stop in `finally`. Only synthetic data and temp HOME are used; no provider,
credential, model turn, live DB or GUI is involved. This proves operation caller
admission and persistence, not later policy enforcement or the install question.
