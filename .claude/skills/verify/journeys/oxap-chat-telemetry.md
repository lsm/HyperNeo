# OXAP chat telemetry

Build the web bundle for the checkout. Follow the shared verification setup and
use the pinned native OXAP binary, Bun and an installed Playwright browser.
Run with a real Codex CLI that is already signed in to ChatGPT. The daemon
and hub have a fresh home and database, and only the Codex CLI child receives
the signed-in home. The proof sends one fixed prompt through the isolated daemon.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/new/evidence-directory \
  .claude/skills/verify/oxap-chat-telemetry.ts /absolute/native/oxap RELEASE-NAME \
  /absolute/codex /absolute/signed-in-home
```

The proof uses the installed OXAP binary through a local release archive and
saves the provider via RPC. It opens the actual chat at desktop and touch phone
widths and records screenshots and the persisted init, reply model and result
values. Baseline fails after the run completes and both screenshots are saved.
