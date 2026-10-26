## Settings > General shows the SDK permission mode by its real name and keeps legacy values (Settings P04)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399):

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/sdk-permission-settings.sh 9321
```

Without Playwright's bundled browser, set `VERIFY_BROWSER` to a local Chrome executable;
it runs headless with a throwaway profile.

The script starts an isolated daemon with `launch.sh` (`env -i`, NODE_ENV=test, its own
HOME, data dir and database, no provider key) and drives headless Chromium with
`sdk-permission-settings-view.mjs`. For each saved global `permissionMode` (unset,
`default`, `bypassPermissions`, `acceptEdits`, `plan`, legacy `delegate`) it seeds the run's
synthetic DB, opens `/settings?tab=general`, and compares the `global_settings` row before
and after the page opens.

End state, in `$RUN/evidence/sdk-permission-settings.json` and `permission-*.png`:
- unset and `default` show `bypassPermissions (Default)`; `bypassPermissions`, `acceptEdits`
  and `plan` show those names; `delegate` shows `delegate (legacy, compatibility unconfirmed)`.
- New choices are only `bypassPermissions (Default)`, `acceptEdits`, `plan`, plus the saved
  value when it is none of these.
- `unchangedByOpen` is true for every case: opening the page writes nothing.
- The row reads `Default or unset runs new HyperNeo SDK sessions with bypassPermissions.`
- Changing the language with `delegate` saved leaves `permissionMode` = `delegate`.
- Picking `plan` saves `plan`.

What the SDK receives for each value is pinned by the `QueryOptionsBuilder` permission-mode
table in `packages/daemon/tests/unit/1-core/agent/query-options-builder.test.ts`; this
journey does not start a model turn.

For actual native SDK spawn mode, inherited user auto settings and a prepared
worker's bypass restriction, also run the `sdk-permission-spawn.md` journey.
