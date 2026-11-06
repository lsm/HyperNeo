## Each fallback row has its own thinking

Build the web UI with `bun run --cwd packages/web build`, then run:

```bash
VERIFY_SETTINGS_PROOF=fallback-thinking-settings.mjs NODE_PATH=<directory-containing-playwright> \
  bash .claude/skills/verify/default-thinking-settings.sh "$RUN" <daemon-port> <mock-port>
```

Use a fresh absolute synthetic run directory and two free ports other than 8399.
Set `VERIFY_BROWSER` when Playwright's own browser is not downloaded.

It checks, in Settings > Models against a real isolated daemon:

- A saved row shows its level, and an unset row shows Use default.
- Opening the page sends no `settings.global.update` frame.
- Choosing a level changes only that row and only `fallbackModels`.
- Move down carries model, provider and thinking together.
- Use default removes the saved level instead of writing one.
- In an override's editor, Cancel writes nothing and Save writes only that
  override, with each level still on its model after a move.
- After reload at 1280px and 390px the values persist and the control fits.

The runtime side is in `fallback-query-wait.md`: its fallback entry carries a
level, and the recovered session must end with that level.

Evidence: `evidence/fallback-thinking-settings.json` and
`evidence/{fallback,override}-thinking-{1280,390}.png`. Unsupported saved levels, unknown
capability and save rollback are covered by the ModelsSettings component tests.
