# Work sessions open in the preview tabs

From 720px a work session opens as a tab in the same strip as previews, with Your
work first. With only Your work there is no tab bar. Below 720px it stays a
full-screen pane with Back. This mirrors the iPad work panel.

Use the resource guard and shared isolated setup from SKILL.md, then build web. The
fixture is `neo-open-controls.ts`: a real daemon, fresh synthetic sessions, a question
card carrying a Report preview, no provider and no external HTTP.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-open-controls.ts after "$READY" &
# when $READY exists:
NODE_PATH=<directory containing playwright> VERIFY_BROWSER=<Chromium executable> \
  node .claude/skills/verify/work-session-tabs-web.mjs "$READY"
kill -USR1 "$(jq .pid "$READY")"; wait
```

Phase `before` records the old behaviour: the session replaces the panel and its tabs.
Phase `after` checks, at 1280px and 1600px: no tabs with only Your work; Open adds Your
work plus the session; a typed draft survives switching tabs; opening the same session
again adds no tab; closing the last tab removes the bar; a session and a preview share
the strip and switch both ways. At 390px the session is full screen with no tabs and
Back returns. Resizing 1280 → 390 → 1280 keeps the session open each way, and with two
session tabs the selected one stays on screen. It then runs
`verifyOpenControls` at desktop and touch, so Open and leaving a session still work.

Inspect the saved `after-*.png` and `after-phone-session.png`. Helpers that enter a
session use `session-pane-web.mjs`, which handles both the tab and the phone pane.
