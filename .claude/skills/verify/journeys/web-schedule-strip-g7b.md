## Web schedule strip (G7b)

Build the web and launch a fresh isolated daemon using [Launch](../SKILL.md#launch). Run
`bun .claude/skills/verify/session-schedule-web.ts <port> "$RUN"`, then the
headless `.claude/skills/verify/session-schedule-web.mjs <port> "$RUN"` with a
Node runtime that can resolve Playwright. `VERIFY_BROWSER` may name a local
Chromium executable, always launched headless with a fresh profile.

The helper creates only synthetic Neo/session goals and reminders through RPC;
last-outcome/skip/nudge values are explicit DB fixtures, not proof of wake delivery.
The browser opens both `/neo` and `/session/<id>` at 1280/390px. Each strip starts
folded and shows only its own target's rows. Expand it, inspect interval/cron,
next/last timestamps, skip reason and nudge distance (or “Nudge due” after the
threshold), then open the goal title's read-only definition. Pause/resume must update
both UI and a fresh real RPC read.
The helper also opens a synthetic Space session route: no strip or schedule list
RPC may be present there, including after focus. `reproduce` as the final browser
argument skips the long visible-refresh check but retains both boundary assertions.
Screenshots: `evidence/schedules-{neo,session}-{1280,390}.png` and
`evidence/schedules-space.png`; assertions and
observed text: `evidence/schedule-web.json`. Inspect screenshots as well.

The strip refreshes every 30s while visible, on window focus and explicit refresh,
and after controls. Goal titles use a disclosure until G6 adds the full goal panel;
this journey does not claim a journal or cross-page goal link. No GUI, model,
provider, real data or GitHub is used. Stop the daemon/mock with `stop.sh`.
