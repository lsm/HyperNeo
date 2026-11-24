# Send after an OXAP hub failure

Build the web bundle from the checkout. Use a pinned native OXAP binary, Bun,
an installed Playwright browser and a real Codex CLI signed in to ChatGPT.
The daemon and hub use an isolated home and database. Only the Codex executable
receives the signed-in home.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/new/evidence-directory \
  .claude/skills/verify/oxap-chat-telemetry.ts /absolute/native/oxap RELEASE-NAME \
  /absolute/codex /absolute/signed-in-home hub-loss
```

The proof starts a shell turn in the web client and stops only its own hub.
A deterministic stderr line repeated by the Codex launcher makes the diagnostic
long enough to reproduce the overlap. Screenshots capture the visible toast and
composer. Verify Send receives a pointer click with the toast visible at desktop
and compact widths, and observe the follow-up reply in the same chat.
