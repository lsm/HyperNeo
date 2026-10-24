# MCP Settings preserve argv boundaries (#8400)

Build the web UI, then run the retained synthetic journey from the worktree root:

```bash
bun run --cwd packages/web build
NODE_PATH=<directory-containing-playwright> \
VERIFY_BROWSER=<installed-Chromium-executable> \
  bash .claude/skills/verify/mcp-args.sh <fresh-absolute-run-directory> 9406
```

VERIFY_BROWSER is optional when Playwright's Chromium is available in the
isolated HOME. The helper owns its NODE_ENV=test daemon on a free non-8399
loopback port, a fresh HOME/data/DB, a GitHub stub and a disposable headless
browser profile. It registers no provider and needs no model mock or real key.
It never reads or changes the human's MCP configs.

The real Settings > MCP Servers form creates one synthetic stdio recorder with
single-quoted path and label arguments containing spaces. The helper reads the
saved entry through mcp.registry.list, starts only that recorder using its
persisted command/argv, and compares its actual stdout argv exactly. The old
form split the path/label and passed quote characters through. After reload,
an unchanged edit/save must produce identical argv. A double-quoted update
also preserves an empty argument and literal $HOME / $(...) text without shell
expansion. Another reload/save retains them; ordinary -y/simple args still work.

Inspect evidence/argv.json and mcp-args.png. The component suite additionally
covers embedded quotes, backslashes, escaped spaces and a refused unmatched
quote without saving. The daemon/repository suites preserve existing array
contracts. This is settings/RPC persistence plus real stdio-child evidence,
not a real-provider SDK session or an external MCP server. The helper closes
its browser and stops/waits for its own daemon on success or failure. Keep the
synthetic evidence before removing the PR worktree.
