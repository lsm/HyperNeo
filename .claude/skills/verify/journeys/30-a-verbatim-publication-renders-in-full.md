# 30. A verbatim publication renders in full

Proves the web slice of `verbatim` publications (#9035): the flag keeps a
publication open on screen — no "more", no collapsed details — while a normal
publication in the same conversation still folds.

With an isolated daemon and web build running (`launch.sh <port> <run>`, mock
provider registered once through RPC):

```bash
VERIFY_BROWSER=<chromium> bun .claude/skills/verify/verbatim-publication-web.mjs \
  <run> <port> <fresh-evidence-dir>
```

The helper seeds two publications straight into the isolated run's
`neo_publications` table (the RPC door cannot publish: the avatar gate admits
only the Neo MCP session) — one `verbatim: true` with a markdown table, quote and
code block, one ordinary short/details pair — then opens `/neo` in a
headless browser and asserts the verbatim bubble shows the table, quote and code
with zero `more` controls and no details block, while the control bubble keeps
its `more` button and hides the table until expanded. Evidence: a full-page
screenshot plus `verbatim-publication.json`.

The verbatim row carries no short text, matching the #9034 contract; the parse
boundary and the flag's storage round-trip are covered by
`publication-client.test.tsx` and `neo-publications.test.ts`. Copy behavior is
asserted in
`NeoPublicConversation.test.tsx`; the browser proof covers rendering only.
