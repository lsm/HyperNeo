# Create a chat with an OXAP provider

Build the web UI, then run `bash .claude/skills/verify/oxap-create-thinking.sh <evidence-dir>` with pinned Bun, Node 24, `PLAYWRIGHT_NODE_PATH` and `VERIFY_BROWSER` set. It starts an isolated daemon on a free loopback port, seeds an OXAP provider, hub, and synthetic model, pairs a browser and cleans up.

A failed provider lookup shows an error and Retry restores the form. Open the
new-chat settings after the picker reports OXAP Codex as the client, then open
Model. The synthetic catalog publishes `low`, `high` and `ultra`. The slider has
stops for `low` and `high`, shows the selected name, and explains that OXAP
cannot send `ultra`. Persisted `off` is ignored for this model and Sandbox stays
hidden. Select `high` and create a chat. In the seeded idle chat, change `high`
to `low` and reload. The touch viewport still shows `low`. Retain
`oxap-thinking-desktop.png` and `oxap-thinking-phone.png`. The fixture uses a
fake Codex CLI that answers `app-server --help` and makes no model turn.

The same journey checks that selecting **Attach image** in an OXAP Codex chat
shows guidance naming the client, model and image-capable option. The chat hides
Tools. The journey captures chat and provider settings in both themes and checks
the selected client, Codex CLI path and OXAP installation. Set
`OXAP_UI_BEFORE=1` when running the same script on the baseline to capture the
old chat and provider settings without requiring the new controls. Compare the
resulting `oxap-chat-*` and `oxap-provider-*` screenshots.

It also checks that a relative executable is refused and a switch back to Claude
Code persists after a reload, without downloading or starting a hub.

It injects a controlled provider lookup failure for an SDK chat, checks that its
current provider's model stays visible and the retry control clears the error,
then retains `sdk-provider-retry.png`.

It also replaces the fixture hub after an 11-second synthetic release download. The real
installer validates and installs a local fixture archive; the UI stays pending
beyond the default timeout, then shows success and the saved hub after reload.

In each theme the OXAP actions menu shows exactly one separator above the
attachment action. Keep `oxap-menu-light.png` and `oxap-menu-dark.png`.

A synthetic auth status card displays a URL followed by punctuation. The browser
checks the link destination excludes that punctuation and keeps `auth-link.png`.

Retain the OXAP and SDK picker and tools screenshots in both themes. The picker
checks that OXAP omits SDK models, while SDK shows thinking and the
Tools/MCP panel. Settings show path, version and hash after the fixture install.

Run the same wrapper with `<evidence-dir> claude-picker` to check an existing
Claude Code chat on the OpenAI provider while its default Client is OXAP Codex.
The browser captures the new-chat and existing-chat menus, selects the second
OpenAI model in the existing chat, and checks that the choice survives reload.
This uses a synthetic OpenAI login and catalog and does not send a model turn.

For the runtime proof, run
`bash .claude/skills/verify/proof-run.sh <new-absolute-evidence-dir> .claude/skills/verify/oxap-codex-thinking.ts <absolute-pinned-oxap> <absolute-codex>`.
This starts an isolated daemon with the real pinned hub and Codex app-server.
A proxy supplies a synthetic account status, and a loopback Responses endpoint
records only the model and effort. The journey checks the native catalog and
all five GPT-6 Luna efforts across open and live updates. It sends `max`
again on the same native thread after restarting the hub. It drops two acknowledgments
after the hub applies a setting, once for a picker change and once for a joint
model and effort change. Both requests fail, and the following turns use the
previous effort on the same thread. It checks both
models' `ultra` refusals and verifies that OXAP returns `schema_invalid`
on both open and live update. To also capture both models
on desktop and phone, build web and set `VERIFY_BROWSER` and `NODE_PATH` with
Node 24 on PATH. The browser verifies five slider stops and selects `max` before
the live turn. While a Sol reply is in progress, changing the slider must leave
the selection on `max` and show a toast asking the user to wait for the reply.
Retain the four picker screenshots, `busy-thinking-toast.png`, `thinking.json`,
and the wrapper exit status.
