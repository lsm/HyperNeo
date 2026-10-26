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

The helper publishes two publications through the real `neo.publication.publish`
RPC on the root Neo conversation — one `verbatim: true` with a markdown table,
quote and code block, one ordinary short/details pair — then opens `/neo` in a
headless browser and asserts the verbatim bubble shows the table, quote and code
with zero `more` controls and no details block, while the control bubble keeps
its `more` button and hides the table until expanded. Evidence: a full-page
screenshot plus `verbatim-publication.json`.

Until the server slice (#9034) lets `neo.publication.publish` omit `shortText`,
the helper sends a short text alongside the flag; the omitted-shortText parse
path is covered by `publication-client.test.tsx`. Copy behavior is asserted in
`NeoPublicConversation.test.tsx`; the browser proof covers rendering only.
