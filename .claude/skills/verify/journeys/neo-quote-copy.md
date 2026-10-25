# Copy plain text from Neo Markdown quotes

Follow the shared build, isolated launch, doctor, and stop setup in `../SKILL.md`.
No model turn or provider registration is needed. Use existing dependencies and
an already installed Chromium; never install a browser for this journey.

```bash
NODE_PATH=<directory containing playwright> VERIFY_BROWSER=<installed Chromium executable> \
  node .claude/skills/verify/neo-quote-copy.mjs "$PORT" "$RUN" before
```

Run `before` against the baseline build to require missing quote controls. After
building the fix, run with `after`. The helper opens Neo via RPC and writes only
synthetic publications to the isolated database. It visits the real `/neo` page
at desktop and touch widths in light and dark mode, copies a formatted quote
using Enter and a nested quote using click or tap, and reads the real clipboard.
It asserts paragraph boundaries, no Markdown syntax, feedback expiry, a 44px
touch target, and a gutter separating text from the button. Inspect the four
screenshots for each phase and retain the JSON observations.

The component regression also expands a collapsed card and copies its quote.
Native iOS must be assessed separately; this journey proves only the web UI.

If Chromium fails before navigation (for example missing framework files), retain
the launch error and report browser proof as pending. Do not change permissions
or system settings. Use the shared owning-shell cleanup instructions.
