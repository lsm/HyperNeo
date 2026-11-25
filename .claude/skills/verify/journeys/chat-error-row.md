# Chat errors scroll with the transcript

Follow the shared resource check and build instructions. Select two distinct free
ports and an absolute evidence directory. Run with Playwright on `NODE_PATH` and
an installed headless Chromium selected by `VERIFY_BROWSER` if necessary.

```sh
VERIFY_MOCK_PORT=9428 bash .claude/skills/verify/with-run.sh \
  bash .claude/skills/verify/chat-error-row.sh 9427 /absolute/evidence
```

The fixture publishes realistic startup, usage-limit and connection failures
through the isolated daemon's session event bus after seeding transcripts. The
browser pairs once and checks each case in fresh desktop and touch-phone contexts
in light and dark. The error title and cause are readable before Details opens.
The row follows the failed request, scrolls out of view with it, reappears on
reload and can be dismissed. Details opens the full technical message.
A separate Codex startup case saves the same diagnostic both as an assistant
message and session error. Require exactly one transcript card before and after
reload, with the explicit launch title, executable path and startup diagnostic,
and the complete saved diagnostic under Details.

The browser also opens Neo's public conversation with a rate-limit failure and
a Space task with an authentication failure. Both show the summary after the
request. The journey writes 18 screenshots and observed results. Inspect them
for clipping and placement. No provider request is sent.
