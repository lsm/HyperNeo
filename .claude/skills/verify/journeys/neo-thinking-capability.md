## Neo thinking follows the model

Build the web UI with `bun run --cwd packages/web build`, then run:

```bash
VERIFY_SETTINGS_PROOF=neo-thinking-capability.mjs NODE_PATH=<directory-containing-playwright> \
  bash .claude/skills/verify/default-thinking-settings.sh "$RUN" <daemon-port> <mock-port>
```

Use a fresh absolute synthetic run directory and two free ports other than 8399.
Set `VERIFY_BROWSER` when Playwright's own browser is not downloaded.

The local model fixture reports no capabilities, so the helper adds them to the
`models.list` frames in the browser: effort levels on one catalog model and
thinking off on another. The daemon, saves and readback stay real. The field's
daemon side is covered by the `models.list` handler test.

It checks, in Settings > Neo model against a real isolated daemon:

- The model with effort levels offers only those levels, the model without
  thinking offers only Off, and each keeps its saved level with a warning.
- Opening the page sends no `neo.preferences.set` frame.
- Saving keeps both unsupported levels as they were.
- After reload at 1280px and 390px the value persists and the control fits.

Evidence: `evidence/neo-thinking-capability.json` and
`evidence/neo-thinking-{1280,390}.png`.
