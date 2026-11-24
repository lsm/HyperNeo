# Chat errors scroll with the transcript

Follow the shared resource check and build instructions. Select two distinct free
ports and an absolute evidence directory. Run with Playwright on `NODE_PATH` and
an installed headless Chromium selected by `VERIFY_BROWSER` if necessary.

```sh
VERIFY_MOCK_PORT=9428 bash .claude/skills/verify/with-run.sh \
  bash .claude/skills/verify/chat-error-row.sh 9427 /absolute/evidence
```

The fixture publishes a structured failure through the isolated daemon's real
session event bus after seeding a scrollable transcript. The browser pairs once
and uses fresh desktop and touch-phone contexts in light and dark. It checks
that the error follows the failed request, scrolls away with the transcript,
opens Technical Details, reappears on reload and can be dismissed. It writes four
screenshots and observed results, including the old placement when run against
the baseline build. Inspect those screenshots for clipping and placement. This
journey does not send a provider request.
