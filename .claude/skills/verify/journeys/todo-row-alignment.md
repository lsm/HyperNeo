# Aligned, quiet work-list todo disclosures

Use shared setup in ../SKILL.md. Only an isolated NODE_ENV=test daemon and headless browser;
never port 8399, live data, real credentials or a visible browser on the human's desktop.

Build packages/web, choose a free port, create a fresh RUN/home, then from the worktree root:

```sh
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/todo-row-alignment-seed.ts "$RUN"
.claude/skills/verify/launch.sh "$PORT" "$RUN"
```

Keep the launch terminal alive. The seed delegates fresh-DB creation to the existing todo
fixture, then binds one synthetic worker so one row has a worker label/Open button and the
other rows do not. No worker turn or external app is opened.

With Playwright installed in a known location and Chromium available, run:

```sh
NODE_PATH=<known-playwright-node_modules> VERIFY_BROWSER=<known-Chromium-executable> \
  node .claude/skills/verify/todo-row-alignment-web.mjs "$PORT" "$RUN" before
```

Capture before changing production code; the before phase records the original alignment.
After fixing/rebuilding the app, run the same command with `after`. Both phases use the
actual /neo work list at 1280 and 390 pixels, with fresh browser contexts. PNGs and measured
JSON go to RUN/evidence/{before,after}/. Inspect both collapsed and expanded screenshots.

The after phase requires every chevron at the same trailing edge, status text sharing a left
edge, and controls staying anchored to their own row's top when detail expands. The visible
control is a quiet 28px arrow target, with its word screen-reader-only and its contextual
accessible name retained. Enter expands, Space collapses, focus stays on the same control,
and Expand all/Collapse all continue working. No horizontal page overflow is permitted.
Component tests additionally protect the shared default text presentation, icon-only mode,
row grid/action alignment classes, and the separate Open callback.

Run doctor.sh and retain its output. Close the owned headless browser and stop only this
run with stop.sh; retain synthetic fixtures/evidence. Merge only with exact-head bot approval
and green required CI, using a manual SHA-pinned REST squash. After automatic deployment,
read back the deployed commit with hyperneo build; remove the owned worktree after merge.
