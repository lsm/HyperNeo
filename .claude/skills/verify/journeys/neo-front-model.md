# Separate front model

Build web for the checkout, then run `neo-front-model.ts` with the checkout head
through `proof-run.sh`, using pinned Bun and Node 24. For the browser check supply
`VERIFY_BROWSER` and `NODE_PATH` for an installed Chromium and Playwright.

The helper owns an isolated daemon and synthetic provider/model catalog. It uses
authenticated RPC to save the coordinator and front preferences independently,
refuses a mismatched provider, and applies a stale generic patch. The front model
must survive that patch while fast replies remain off. No provider request runs.

The browser uses a fresh paired context and the built settings UI. Select a model
from another provider, reload, and verify persistence and the default-off switch.
Retain `observed.json`, `browser.json`, the screenshot and wrapper exit status.
