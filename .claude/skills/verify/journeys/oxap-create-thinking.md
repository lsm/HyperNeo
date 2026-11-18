# Create a chat with an OXAP provider

Build the web UI, then run `bash .claude/skills/verify/oxap-create-thinking.sh <evidence-dir>` with pinned Bun, Node 24, `PLAYWRIGHT_NODE_PATH` and `VERIFY_BROWSER` set. It owns an isolated daemon, seeds an OXAP provider and synthetic model, pairs a browser and cleans up. Port 31397 must be free.

A failed provider lookup shows an error and Retry restores the form. The create form hides thinking and sandbox for OXAP, even with persisted `off` thinking and enabled sandbox selections. Creating a chat succeeds and the session model picker hides thinking; light and dark screenshots show the form. The fixture supplies a synthetic model catalog and does not make a model turn.

The same journey checks that the OXAP chat explains its text-only input, disables
image attachment, and hides Tools. It captures chat and provider settings in
both themes and checks the selected harness, executable and hub binary. Set
`OXAP_UI_BEFORE=1` when running the same script on the baseline to capture the
old chat and provider settings without requiring the new controls. Compare the
resulting `oxap-chat-*` and `oxap-provider-*` screenshots.

It also checks that a relative executable is refused and a switch back to Claude
Code persists after a reload, without downloading or starting a hub.

It injects a controlled provider lookup failure for an SDK chat, checks that its
current provider's model stays visible and the retry control clears the error,
then retains `sdk-provider-retry.png`.

It also saves OXAP after an 11-second synthetic release download. The real
installer validates and installs a local fixture archive; the UI stays pending
beyond the default timeout, then shows success and the saved hub after reload.

In each theme the OXAP actions menu shows exactly one separator above the disabled
attachment action. Keep `oxap-menu-light.png` and `oxap-menu-dark.png`.

A synthetic auth status card displays a URL followed by punctuation. The browser
checks the link destination excludes that punctuation and keeps `auth-link.png`.
