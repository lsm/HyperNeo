# Switch models in the old web UI

Build the web bundle and follow the isolated setup in `../SKILL.md`. With
pinned Bun, Node 24, `PLAYWRIGHT_NODE_PATH` and `VERIFY_BROWSER` set, run:

```sh
bash .claude/skills/verify/oxap-create-thinking.sh /absolute/fresh/evidence-directory claude-picker
```

The browser opens an existing Claude Code chat and chooses GPT-5.6-Luna. The
fixture holds the switch request at the browser boundary for 11 seconds.
The model picker must stay disabled throughout the wait. The browser then
forwards the request to the isolated daemon. The picker must re-enable, show
GPT-5.6-Luna and still show it after reload. Keep the wrapper exit status and
`existing-claude-picker-pending.png` with the other picker screenshots.
