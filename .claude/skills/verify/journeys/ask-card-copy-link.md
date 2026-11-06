# Copy a Neo work-card link

Follow SKILL.md's shared resource check, disposable HOME/data and cleanup setup.
Build the current web bundle first, then run this provider-free browser journey.

```sh
cd packages/web && bun run build && cd ../..
TMPDIR=/private/tmp NODE_PATH=<existing-playwright-node-modules> VERIFY_BROWSER=<installed-chromium> \
  bash .claude/skills/verify/proof-run.sh <fresh-absolute-evidence-directory> \
  .claude/skills/verify/ask-card-copy-link.ts
```

The helper owns an isolated daemon and static listener on random loopback ports,
stops the job processor, and seeds one synthetic ask. The browser uses only that
run's local credential. External browser requests and gh calls are refused.

At 1280 and 390 pixels, in English and Simplified Chinese, open the actual card
menu and click Copy link / 复制链接. The real clipboard must equal one Markdown
line containing the full escaped card title and `<location.origin>/ask/<askId>.md`. The
fixture covers brackets, backslashes and a multiline title. The page URL stays
unchanged and clicking Copy link sends no operation request. A synthetic query
and fragment on the page must be absent from the copied link. Then fetch the copied
URL with the isolated credential and require HTTP 200, text/markdown, no-store,
and the expected card heading. The fixture forwards that path to the real daemon
HTTP handler supplied by the base branch. Inspect each saved
menu PNG and browser.json. Component tests additionally cover settled cards and
copying while mutation actions are disabled.
Before capturing the menu, wait for finite UI animations to finish and require
its horizontal bounds to fit the viewport. Keep the saved menu-bounds JSON so
an opening animation cannot be mistaken for the settled layout.

The helper closes its browser, listeners and daemon even on failure. The shared
wrapper preserves evidence and removes its temporary HOME/DB. No provider keys,
live daemon or native navigation are involved. The Markdown GET implementation
belongs to the base branch; this journey verifies that the copied target resolves.
