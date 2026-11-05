# Space-off boot

Prove a daemon with Space left out boots on a fresh database and creates no
Space tables. Run from the worktree root with no daemon or mock server needed:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-space-off-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" TMPDIR="$RUN" NODE_ENV=test HYPERNEO_SPACE=off \
  HYPERNEO_DATA_DIR="$RUN/data" bun scripts/bun-daemon-boot-probe.ts "$RUN"
```

`$RUN/evidence/bun-daemon-boot.json` must show `pass: true`, `spaceTables: 0`
and `noMissingTables: true`. The probe builds the Space table list from
`SPACE_SCHEMA.baseline`, drives session, message and live-query reads, then
stops the daemon. `bun-daemon-boot-probe.test.ts` runs this in CI.
