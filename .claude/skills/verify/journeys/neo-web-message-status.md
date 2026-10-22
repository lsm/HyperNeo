# Web displays daemon-owned human-message status

Use the shared metadata-only daemon isolation in SKILL.md. This helper builds
web, owns an isolated test daemon with fresh HOME/data/DB, and stops it on exit.
No provider or model is needed; only synthetic fixture data is seeded. Supply
NODE_PATH for installed Playwright and VERIFY_BROWSER for an installed Chromium
executable when the matching Playwright browser is unavailable.

```bash
NODE_PATH=<directory-containing-playwright> VERIFY_BROWSER=<chromium-executable> \
  bash .claude/skills/verify/neo-web-message-status.sh /tmp/hyperneo-web-status-fresh 9473
```

The real daemon's two conversation readers must return the same six statuses.
The actual built `/neo` page runs headlessly at 1280 and 390 px. Every human
message must display its supplied Received, Queued, Working, Read, Answered or
Failed label. An older read input must not become working because another input
owns the turn. Read's title explicitly says it has not been answered.

The fixture then records ordinary consumption and emits the existing neo.changed
event through a harmless synthetic mute preference. Both pages must refresh the
same queued input to Read. An explicit publication plus another refresh changes
it to Answered, with no added human input or page reload. The hook contract
also loads an earlier page and verifies that neo.changed refreshes a cited input
there, preserving the loaded history and cursor. No status is inferred
from message position, publications in the visible page, or SDK turn state.

Evidence: evidence/neo-web-message-status.json and status-{initial,read,answered}
screenshots at both widths. The helper always uses headless Chromium, never an
unattended desktop GUI, real credentials, real DB or port 8399. No iOS rendering
or live restart is claimed.
