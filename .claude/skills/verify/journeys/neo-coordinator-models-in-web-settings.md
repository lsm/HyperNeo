## Neo coordinator models in web Settings

Build the web UI with `bun run --cwd packages/web build`, then run:

```bash
NODE_PATH=<directory-containing-playwright> \
  bash .claude/skills/verify/neo-model-settings.sh "$RUN" 9381 9382
```

Use a fresh absolute synthetic run directory. Both ports must be free and neither
may be 8399; the helper uses a separate local model fixture without port 8000.
It starts from `env -i`, synthetic HOME/data/DB, NODE_ENV=test and a GitHub stub.
The only synthetic provider credential is created through RPC in that test DB.
Set `VERIFY_BROWSER` to an installed Chromium executable when Playwright's own
headless browser is unavailable. The browser always runs headlessly.

The actual built Settings > Neo model page shows one ordered list; the first
model is the primary. The helper adds three models through the shared model
picker ("Add Neo model"), sets each thinking level, reorders and saves. "Make
primary" moves a model to the top of the list. The helper checks persisted preferences through real `neo.snapshot` RPC,
sets the primary's auto-compact to 70% (shown as "70% ≈ …K of …K tokens" from that
model's catalog window; each model has its own field; compaction copy says it applies when idle),
then reloads desktop/mobile pages and checks values, order, usable provider text
and control bounds. Clearing saved fallbacks (button "Clear saved fallbacks") must persist an explicit empty chain
after reload, shown as "No saved fallbacks.". Evidence: `evidence/neo-model-settings.json` and desktop/mobile PNGs.
Browser and helper-owned daemon/mock close on success or failure.

Focused Settings contracts also cover cross-provider catalog entries, server
thinking options, unavailable providers, human-operation refusal retaining edits
and primary-only edits preserving inherited fallback behavior. This web journey
uses synthetic Anthropic models; the former Neo-only execution journey was retired in #8114; see
[model runtime removal](neo-coordinator-model-fallback-backend.md). Stored Neo
fallback preferences no longer override the ordinary session recovery policy. No real account quota or GUI session
is used. The Settings PR contains no new fallback execution policy.

It also checks 90 resets to an omitted override, the Neo popover links to the new
page, and ordinary Settings > Models contains no Neo preference controls.

The auto-compaction percentage control in #8121 keeps its existing preference
and snapshot API. Its value writes the ordinary per-session setting; verify
its daemon behavior with [per-session compaction](neo-auto-compact-percentage.md).
