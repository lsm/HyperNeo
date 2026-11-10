# Space-off boot

Prove a daemon boots with Space off, the default, and on a fresh database creates no
Space-extension tables. The core `space_github_*` tables stay in both modes because
Neo's PR watching uses them, so `spaceTables: 0` does not mean no `space_*` table. Run from the worktree root with no daemon or mock server needed:

```bash
RUN=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-space-off-XXXXXX")" && pwd -P)
env -i HOME="$RUN/home" PATH="$PATH" TMPDIR="$RUN" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" bun scripts/bun-daemon-boot-probe.ts "$RUN"
```

`$RUN/evidence/bun-daemon-boot.json` must show `pass: true`, `spaceTables: 0`
and `noMissingTables: true`. The probe builds the Space table list from
`SPACE_SCHEMA.baseline` plus `SPACE_SCHEMA.tables`, drives session, message and live-query reads, then
stops the daemon. `bun-daemon-boot-probe.test.ts` runs this in CI.

For a database that already has Space tables, run
`.claude/skills/verify/space-off-old-db.ts` through `proof-run.sh`, with
`VERIFY_BROWSER` and `NODE_PATH` for the web check. It creates a space with
`HYPERNEO_SPACE=on`, boots with the default, and requires every Space table's
schema and row count unchanged, no `space` extension, no `space.list` handler,
no Space entry on the web, and no error in the log. Then it turns Space back on
and finds the old row. Unset `HYPERNEO_SPACE` in that run's shell: `proof-run.sh`
defaults it to `on` for proofs that need Space, and this helper sets it itself.
