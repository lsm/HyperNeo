# Neo fits phone viewports without page-level sideways scrolling

Use SKILL.md's resource guard, isolated proof wrapper and installed browser paths.
Build web for the current checkout, then run:

```sh
NODE_PATH=<existing Playwright modules> VERIFY_BROWSER=<Chromium executable> TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-mobile-overflow.ts after
```

The metadata-only helper owns an ephemeral daemon/frontend with synthetic HOME,
DB and sessions. No model, provider or live daemon is used. It publishes through
the real MCP door and seeds human messages, long work/todo titles, choice questions
and worker transcript content. Test at 390x844 and 360x800 with touch emulation,
plus a 1280px desktop comparison. Cover conversation, expanded human messages,
long draft, settings drawer, work sheet, All dialog and local session pane.

Require document scrollWidth <= clientWidth and no overflow in the containing
chat, work, composer or header boxes. Long links wrap; wide code/table children
remain scrollable inside themselves. Inspect before/after screenshots and the
element geometry in browser.json. The before phase records real offenders;
the after phase fails on any remaining overflow. Require wrapper exit zero and
resourcesClosed:true; browser, frontend and daemon close in finally.
