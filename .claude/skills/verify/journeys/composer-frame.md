# Composer parity: visual tokens and frame

Use pinned Bun and shared resource preflight from SKILL.md, install frozen
dependencies, and build the web at the checked-out head. Then run:

```bash
VERIFY_BROWSER=<installed-chromium> VERIFY_PLAYWRIGHT=<playwright-package-path> \
VERIFY_MOCK_PORT=19347 VERIFY_KEEP_RUN=1 \
  bash .claude/skills/verify/with-run.sh bash .claude/skills/verify/composer-frame.sh 19346
```

The wrapper launches an isolated daemon and mock, pairs a synthetic browser,
and enables fake batch dictation. No real microphone, speech service or model
turn is used. Both themes run at 390px touch and 1280px desktop. Verify the idle
capsule keeps its border and 48px height; an expanded blurred draft has a transparent
border and the 6px/32px/12% shadow; focus and recording use the accent border.
Token receipts cover send, send foreground, control fill and danger in both themes.
Review all screenshots for clipping and contrast. Recording is cancelled without
sending; both owned processes must stop. Keep composer-frame.json and screenshots.
Button geometry, content layout and dictation behavior belong to later parity PRs.
