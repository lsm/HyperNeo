# Home sync conflict question and full versions

This journey presents the conflict. Application is covered separately by
`neo-home-apply-choice.md`, including protected-file confirmation and stale-version
refusal. The card explicitly says answering alone does not apply a change.
Security #7975, native Read and command-line safety parsing are outside this slice.

Run from the worktree root. Build the web UI, then run the retained helper with a
fresh absolute directory and a free port other than 8399:

```bash
(cd packages/web && bun run build)
NODE_PATH=<installed-playwright-node_modules> VERIFY_BROWSER=<headless-chromium-executable> \
  bash .claude/skills/verify/neo-home-conflicts.sh "$RUN" after 9407 web
```

Omit `web` for RPC-only proof. This runner owns its NODE_ENV=test CLI daemon,
HOME, Git identity, DB and two synthetic local Git repositories; it starts with
`env -i`, no provider credentials, and a refusing gh stub. It stops only its own
daemon on exit. There is no model turn, network Git remote or real GitHub call.
It uses the actual `operation.invoke` WebSocket surface, not a service-only test.

The helper creates divergent `direction.md` commits. Read and save both refuse;
there is exactly one human choice question, bounded compact diff and separate full
version document. Both complete texts (including trailing spaces), commit IDs,
local HEAD and clean status are checked. The RPC `neo.question.get` exposes that
same document. The save request must not write its proposed notes file.

Headless Chrome visits the actual built `/neo` at 1280 and 390 pixels, opens Your
work on the phone width, waits for the real drawer and Markdown rendering, then
opens View full report. It waits for the document animation before screenshots;
the literal `<pre>` text must exactly equal the persisted document, markup must
not execute, and answer controls remain usable (choice buttons include their A/B/C letter prefixes). This is unattended headless
verification, not an interactive GUI run. No human answer is sent by the browser.

Evidence is under `$RUN/evidence/`: `neo-home-conflicts.json`,
`neo-home-conflicts-web.json`, `conflict-card-{1280,390}.png` and
`conflict-document-{1280,390}.png`. Read the screenshots before calling this a
pass. A missing card/document, text mismatch, or offscreen settled card fails.

Before-fix reproduction: at the tests-first commit, run a fresh directory with
`before` instead of `after`, without `web`. It records the real conflict refusal,
unchanged local file/HEAD/status and zero questions. The focused contracts also
cover repeated reads, a recreated repository service and a recorded answer:
there is still only one question and no file application. Migration contracts
preserve legacy answers; trimming a large MCP snapshot keeps the question while
full versions remain retrievable using `neo.question.get`.

Not verified here: provider-driven model behavior, the separate choice-application
path, phone hardware or real network remotes. Nothing resolves a conflict or
changes either saved version in this journey.
