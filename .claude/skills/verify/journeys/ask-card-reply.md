# Ask menu Reply matches iOS (#8407)

Follow shared isolation setup in `../SKILL.md`. Build `packages/web`, create a
fresh absolute RUN with `home/` and `bin/`, then run from the worktree root:

```sh
env -i HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  PATH="$RUN/bin:$(dirname "$(command -v bun)"):$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin" \
  NODE_PATH="$NODE_PATH" VERIFY_BROWSER="$VERIFY_BROWSER" \
  bun .claude/skills/verify/ask-card-reply.ts "$RUN"
```

The helper owns an ephemeral isolated daemon/static listener and a disposable
headless browser, with no provider, credential files, real data or port 8399.
At 402/1280 widths it opens the synthetic ask's actions, observes Reply first,
clicks it, and requires the composer to quote “Draft the iOS API client” as Neo,
keep the existing draft and focus the textarea. The narrow work sheet closes.
Inspect `evidence/web-menu-*.png`, `web-composer-*.png`, `browser.json` and
`observed.json`; the ask stays open. Both listeners/browser close in finally.
Component integration tests additionally send the draft with exactly
`replyTo: {kind: 'ask', id: <ask id>}`, without a quoted text prefix, matching
the iOS app. Question replies retain their behavior.

For iOS comparison, use a disposable source checkout of the iOS app and an
owned Simulator (never Simulator.app or a physical phone). Add the retained
`../ask-card-reply-ios.swift` helper to its UI test target and run that test
using the app's UI-test scheme, the owned Simulator's explicit UDID,
`-collect-test-diagnostics never -parallel-testing-enabled NO`, and
`-only-testing:<UI-test-target>/AskReplyEvidenceTests`. The existing offline demo
uses synthetic data; no iOS app source changes. Export attachments with
`xcresulttool export attachments`: menu and composer screenshots must show Reply
and the same quoted title. Compare them beside the web shots in the PR. This
comparison exercises native menu/composer navigation, not a real provider turn.
Shut down/delete only the owned Simulator and remove the temporary checkout after
retaining local evidence. Remove the PR worktree after merge/close.
