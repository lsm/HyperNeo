# Copy plain text from Neo Markdown quotes

Follow the shared build, isolated launch, doctor, and stop setup in `../SKILL.md`.
No model turn or provider registration is needed. Use existing dependencies and
an already installed Chromium; never install a browser for this journey.

First run `node .claude/skills/verify/neo-quote-copy.mjs "$PORT" "$RUN" seed-only`
to test the fixture without opening a browser. It seeds a UUID publication and
reads it back through the real `neo.publication.read` RPC, requiring its complete
quote text to be readable. All phases perform this check before browser startup
and save `evidence/quote-copy-seed.json`. A seed failure is not a browser failure.

```bash
NODE_PATH=<directory containing playwright> VERIFY_BROWSER=<installed Chromium executable> \
  node .claude/skills/verify/neo-quote-copy.mjs "$PORT" "$RUN" before
```

Run `before` against the baseline build to require missing quote controls. After
building the fix, run with `after`. The helper opens Neo via RPC and writes only
synthetic publications to the isolated database. It visits the real `/neo` page
at desktop and touch widths in light and dark mode, copies a formatted quote
using Enter and a nested quote using click or tap, and reads the real clipboard.
Desktop uses English; touch uses Chinese browser language. Require the matching
localized quote label and copied feedback. The component regression also switches
language while the quote is mounted, without changing the copied text.
It asserts paragraph boundaries, no Markdown syntax, feedback expiry, a 44px
touch target, and a gutter separating text from the button. The quote also
contains a highlighted Python fence with indentation and multiple blank lines,
plus a multiline display-math formula: the clipboard must keep the code
whitespace, contain the formula source exactly once, and keep its paragraph
boundaries. Inspect the four screenshots for each phase and retain the JSON
observations.

The component regression also expands a collapsed card and copies its quote.
Native iOS must be assessed separately; this journey proves only the web UI.

If Chromium fails before navigation (for example missing framework files), retain
the launch error and report browser proof as pending. Do not change permissions
or system settings. Use the shared owning-shell cleanup instructions.
