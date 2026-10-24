## Default thinking sits beside the default model

Build the web UI with `bun run --cwd packages/web build`, then run:

```bash
NODE_PATH=<directory-containing-playwright> \
  bash .claude/skills/verify/default-thinking-settings.sh "$RUN" 9391 9392
```

Use a fresh absolute synthetic run directory and two free ports other than 8399.
The helper starts the daemon and the local model fixture from `env -i` with
`NODE_ENV=test`, a synthetic HOME/data/DB and the GitHub stub, registers the
dev-proxy key over RPC only, and drives the built UI in a headless browser. Set
`VERIFY_BROWSER` to an installed Chromium/Chrome executable when Playwright's
own headless browser is not downloaded.

It checks, as a user would see it:

- Settings > General has no thinking control.
- Settings > Models shows "Thinking" under Default Model with the saved global
  `thinkingLevel`, the options that model's (or its provider's) thinking
  capability allows, and no "unknown" note for a catalog Anthropic model.
- Opening General and Models sends no `settings.global.update` frame and leaves
  the global settings snapshot unchanged.
- Choosing a level changes only `thinkingLevel` in global settings; Neo's own
  `neo.preferences.thinkingLevel` is unchanged.
- A new `session.create` with no model or thinking gets the default model,
  provider and the chosen thinking level.
- After reload at 1280px and 390px the value persists and the control fits.

Evidence: `evidence/default-thinking-settings.json` and
`evidence/default-thinking-{1280,390}.png` (failure screenshot and page text on
error). Unsupported saved values and save rollback are covered by the
ModelsSettings component tests, not by this journey.
