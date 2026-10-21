## Follow-topic refresh responsiveness

After the card-topic expiry sweep, `refreshDriverWork` follows subscriptions for
checkable todos. This journey exercises that actual refresh over an isolated
daemon WebSocket, with 180 synthetic named PR links, two retained topics per
todo and one removed todo. Its GitHub reader returns synthetic empty results;
there is no root session binding, provider, live data or external request.

```bash
RUN=$(mktemp -d /private/tmp/hn-follow-topics-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/follow-topics-lag.ts verify 9378 "$RUN" enabled 8
```

Repeat with `disabled 8` in a fresh directory. The 8 ms controlled wait models
slow settings reads; `enabled 0` and `disabled 0` measure native reads without
injected latency. Before the fix, `reproduce` must record 180 settings reads in
the follow phase and over 1 s max lag with the controlled wait. Fixed `verify`
must record one follow-phase settings read, including disabled delivery, max
lag below 1 s and a concurrent `system.health` reply below 250 ms. The preceding
expiry stage retains its own once-per-sweep settings read; those two reads are
reported separately. The next actual refresh must observe flipped pack settings.

`observed.json` retains phase totals, subscription counts, health latency and
lag diagnostics. Enabled refresh retains 360 synthetic topics and adds 180 PR
topics; disabled refresh expires all 362 initial topics. After changing settings,
the next refresh respectively expires all topics or adds 180 PR topics. Focused
tests also cover an empty pack list, direct-call freshness, duplicate watch
suppression and no followed todos. A controlled wait proves amplification of
slow settings, not the cause of any historical live off-CPU event. The helper
closes its own socket, timer, monitor, Neo service and daemon in `finally`.
