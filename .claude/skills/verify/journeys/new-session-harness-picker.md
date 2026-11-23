# Choose a harness in the new-chat form

Build the web UI and follow the isolated setup in `../SKILL.md`. With pinned
Bun, Node 24, `PLAYWRIGHT_NODE_PATH` and `VERIFY_BROWSER` set, run:

```sh
bash .claude/skills/verify/oxap-create-thinking.sh /absolute/fresh/evidence-directory harness
```

At 1280 px and at 390 px with a coarse pointer, the form shows the Claude Code
provider default beside the Codex model. Starting that chat omits the override.
Choosing OXAP Codex sends the override and stores OXAP. Reopening the form
shows the provider default again. Changing the provider default in settings then
allows the journey to verify the reverse override to Claude Code. DeepSeek's
compatible OXAP option remains visible and disabled with the Settings hint
while its key is missing. The journey forwards real create requests and holds
the first message at the browser boundary.

Keep `default-1280.png`, `override-1280.png`, `disabled-1280.png` and their
`-390.png` counterparts.
