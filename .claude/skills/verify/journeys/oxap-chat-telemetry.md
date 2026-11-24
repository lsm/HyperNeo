# OXAP chat telemetry

Build the web bundle for the checkout. Follow the shared verification setup and
use the pinned native OXAP binary, Bun and an installed Playwright browser.
Run with a real Codex CLI that is already signed in to ChatGPT. The daemon
and hub have a fresh home and database, and only the Codex CLI child receives
the signed-in home. The proof sends a fixed prompt through the isolated daemon.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/new/evidence-directory \
  .claude/skills/verify/oxap-chat-telemetry.ts /absolute/native/oxap RELEASE-NAME \
  /absolute/codex /absolute/signed-in-home
```

The proof uses the installed OXAP binary through a local release archive and
saves the provider via RPC. It opens the actual chat at desktop and touch phone
widths. It expands Session Started and the result to verify the model, cwd,
client, permission mode, positive elapsed time and token counts. Missing cost
and API duration stay absent. The context ring reports that usage is unavailable.
After the screenshots, a second turn confirms the init is not duplicated. The
proof restarts the hub and checks the third turn reopens the same native thread
and adds one init.

On the baseline, the turn completes and screenshots are saved before the init
assertion fails. No API keys enter the daemon or hub environment.
