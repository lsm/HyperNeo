# Scheduler bookkeeping stays outside chat

Use SKILL.md's resource checks, frozen install, current web build and isolated
proof-run.sh setup. Run session-schedule-idle.ts first as described in the
idle-backoff journey. It observes the real daemon publication/RPC surface across
repeated idle stretches and preserves cadence/status facts with zero messages.

Then run neo-conversation-schedules.ts through proof-run.sh, setting
VERIFY_BROWSER to an installed Chromium executable and NODE_PATH to existing
Playwright dependencies. The helper owns a fresh test daemon and guarded web
preview on ephemeral loopback ports. Pairing uses the run's single-use synthetic
code. No provider, real database or live daemon is used. All resources close in
finally and the wrapper preserves evidence before deleting synthetic data.

The browser checks 1280px desktop and 390px touch layouts. The human request and
Neo reply stay in chat. Neither scheduled rows nor schedule controls appear in
chat. The existing work panel contains completed and running schedule rows;
settlement text is invisible until more and hidden again after less. Inspect
conversation-1280.png and conversation-390.png alongside browser.json. This does
not verify native iOS or live deployment.
