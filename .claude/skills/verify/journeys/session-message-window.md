# A session opens on its last 50 messages

Use the shared isolation in SKILL.md. The helper builds web, owns a test daemon
with fresh HOME, data and DB, and seeds 120 synthetic messages into one session.
No provider, model or real data is used. Supply NODE_PATH for Playwright and
VERIFY_BROWSER for a Chromium executable.

```bash
NODE_PATH=<directory-containing-playwright> VERIFY_BROWSER=<chromium-executable> \
  bash .claude/skills/verify/session-message-window.sh /tmp/hyperneo-message-window-fresh 9475
```

A paired browser opens `/session/<id>`. It must show rows 70 to 119 only. Load
more must add rows 20 to 69, then rows 0 to 19, and the button must then go away.
Evidence is `evidence/observed.json` and `session-window.png`. Delete the run
directory afterwards. A live message sliding the window is covered by the store
tests, because this journey has no model to produce one.
