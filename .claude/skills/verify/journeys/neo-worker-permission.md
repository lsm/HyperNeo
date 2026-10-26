## Settings > Neo model sets the permission mode of Claude workers Neo starts (Settings P08)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399). Without Playwright's bundled browser, set `VERIFY_BROWSER` to a local
Chrome executable; it runs headless with a throwaway profile.

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/neo-worker-permission.sh 9322
```

The script puts the synthetic `claude`/`script` fixture
(`packages/daemon/tests/fixtures/claude-b1-cli.ts`) first on the daemon's PATH, imports one
synthetic desk helper so the `claude-desktop` adapter exists, and starts an isolated daemon
with `launch.sh` (`env -i`, NODE_ENV=test, its own HOME, data dir and DB, no provider key).
`neo-worker-permission-view.mjs` seeds `neo` with synthetic rules, packs, mutes and
autoDispatch, then for unset and each of `bypassPermissions`, `auto`, `acceptEdits`,
`default` opens `/settings?tab=neo-model` headless and compares the settings row before and
after. It picks `acceptEdits` in the page, then `work.start` on `claude-desktop` launches a
synthetic worker. No real Claude, app or GUI runs.

End state, in `$RUN/evidence/`:
- `neo-worker-permission.json`: unset shows `auto (not set)`; the four values show by name;
  `unchangedByOpen` is true for each; after the pick `neo` holds `acceptEdits` and the same
  rules, packs, mutes and autoDispatch.
- `worker-permission-1280.png`, `worker-permission-390.png`: the "Workers" row with
  "Claude Code workers Neo starts from now on use this mode; running sessions keep theirs."
- `prepare-args.jsonl`: the `P08 synthetic worker` launch carries
  `--permission-mode acceptEdits`. The script fails otherwise.

`work-start.json` may end `not_delivered`: the fixture stops after the launch, and this
journey checks only the mode the launcher receives.
