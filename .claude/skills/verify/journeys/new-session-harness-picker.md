# Choose a client in the new-chat form

Build the web UI and follow the isolated setup in `../SKILL.md`. With pinned
Bun, Node 24, `PLAYWRIGHT_NODE_PATH` and `VERIFY_BROWSER` set, run:

```sh
bash .claude/skills/verify/oxap-create-thinking.sh /absolute/fresh/evidence-directory harness
```

At 1280 px and at 320, 390, 744, 820, 1024 and 1180 px with a coarse pointer,
the journey checks that
the model picker, round Sandbox button and send button stay on one line. The
model picker shows the Claude Code provider default beside the Codex model and
shows the choices under Client. Open Model & thinking to browse and search models while the Thinking slider
stays visible beneath the scrollable list. Client opens in its own view.
Opening the menu or model view leaves the search field unfocused. Starting a chat with the default client omits
the override.
Choosing OXAP Codex sends the override and stores OXAP. Reopening the form
shows the provider default again. Changing the provider default in settings then
allows the journey to verify the reverse override to Claude Code. DeepSeek's
compatible OXAP option remains visible and disabled with the Settings hint
while its key is missing. When the default model does not match the catalog,
an override sends the provider alone and the daemon resolves the fallback.
The journey forwards real create requests and holds the first message at the
browser boundary.

Keep `client-picker-default-1280.png`, `client-picker-override-1280.png`,
`client-picker-disabled-1280.png` and their `-390.png` counterparts.

For native tablet verification, open an isolated fixture in iPad Simulator
Safari and check portrait and landscape. Capture the composer and the Client
view for the provider default, a selected override, and an unavailable client.
Open Model & thinking and tap Search separately to check that only the
deliberate search opens the software keyboard and models and Thinking remain
visible above it. Use simulator screenshots for this check.
