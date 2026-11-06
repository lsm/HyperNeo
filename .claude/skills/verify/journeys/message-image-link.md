# Message windows link large images instead of carrying them

Use the shared isolation in SKILL.md. The helper builds web, owns a test daemon
with fresh HOME, data and DB, and seeds five synthetic 6.7 MB PNG messages. No
provider, model or real data is used. Supply NODE_PATH for Playwright and
VERIFY_BROWSER for a Chromium executable.

```bash
NODE_PATH=<directory-containing-playwright> VERIFY_BROWSER=<chromium-executable> \
  bash .claude/skills/verify/message-image-link.sh /tmp/hyperneo-message-image-fresh 9476
```

- `messages.bySession` and `message.sdkMessages` return all five rows under 16 KB,
  five timed reads each.
- The image URL answers 401 with no credential and with an agent credential; a
  paired browser's cookie gets the exact stored bytes.
- A paired browser opens the raw `/session/<id>` view, sees placeholders with no
  image request, opens one and loads the full image from its URL.

Evidence is `evidence/message-image-link.json`, `session-placeholders.png` and
`session-full-image.png`. The phone is not covered. Delete the run directory afterwards.
