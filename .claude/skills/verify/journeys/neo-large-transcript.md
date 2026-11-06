# Neo keeps its composer when the raw transcript is too large

Use the shared isolation in SKILL.md. The helper builds web, owns a test daemon
with fresh HOME, data and DB, and seeds five synthetic 9 MB image messages into
the Neo session. No provider, model or real data is used. Supply NODE_PATH for
Playwright and VERIFY_BROWSER for a Chromium executable.

```bash
NODE_PATH=<directory-containing-playwright> VERIFY_BROWSER=<chromium-executable> \
  bash .claude/skills/verify/neo-large-transcript.sh /tmp/hyperneo-large-transcript-fresh 9474
```

`messages.bySession` must fail with MESSAGE_TOO_LARGE, proving the fixture is
over the outbound limit. A paired browser then opens `/neo`. The composer must
render, a typed message must stay on the page after a pause and a reload, and
its ask must reach
`neo_conversation_asks`. Evidence is `evidence/observed.json`, `neo-page.png`,
`neo-sent.png` and `neo-reloaded.png`. Delete the run directory afterwards.
