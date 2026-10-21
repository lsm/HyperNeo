## Neo question-card Markdown (headless)

Build web and Launch a fresh isolated synthetic daemon on a free non-8399 port.
In the same shell, with a `stop.sh` EXIT trap, run:

```bash
NODE_PATH=<directory containing playwright> node .claude/skills/verify/neo-question-markdown.mjs 9379 "$RUN"
```

Set `VERIFY_BROWSER` to an installed Chromium executable if needed. The helper
opens Neo over RPC and seeds only its own temporary DB with open, answered and
retired questions. It drives the actual built `/neo` page headlessly at 1280 and
390 pixels, opens Details, and checks real lists, bold, code, tables, links and
single line breaks in each state. Raw HTML must remain escaped, question bounds
must fit the viewport, and answer controls and historical metadata must remain.
Evidence: `evidence/neo-question-markdown.json` and screenshots at both widths.
No provider, model, credentials, live data or desktop GUI is used. Stop the daemon
and mock with `stop.sh`. The focused `NeoAskTodos.test.tsx` uses the real chat
renderer; its three formatting contracts fail on the test-first commit.
