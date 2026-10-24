## Neo muted sessions in web Settings

Build the web UI with `bun run --cwd packages/web build`, then run:

```bash
NODE_PATH=<directory-containing-playwright> \
  bash .claude/skills/verify/neo-muted-sessions-settings.sh "$RUN" 9393
```

Use a fresh absolute synthetic run directory and a free port other than 8399. The
helper starts the daemon from `env -i` with NODE_ENV=test, a synthetic HOME, data
dir and DB, and a GitHub stub; no provider credential is created. Set
`VERIFY_BROWSER` to an installed Chromium executable when Playwright's own browser
is unavailable. The browser always runs headlessly.

It creates one synthetic HyperNeo session and mutes four keys through
`neo.session.mute`: that session, a HyperNeo key with no session, a Codex key from
another daemon and a Claude Desktop key. Settings > Neo model > Muted sessions
lists all four by their original key and shows a name only for the session the
web already knows. Unmute on the Codex row removes it only after the daemon
answers, and `neo.snapshot` mutedSessions then lacks only that key. With the
daemon stopped, Unmute keeps the row and says to reconnect; after a restart the
snapshot is unchanged. After reload at 1280 and 390 px the list matches the
snapshot and every control fits. Evidence: `evidence/neo-muted-sessions-settings.json`,
the disconnected and desktop/mobile PNGs. The helper-owned daemon and browser
close on success or failure.
