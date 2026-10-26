# Waiting on you cards lead the work list

Use the shared setup in ../SKILL.md. This journey covers the actual web /neo work
list at 1280×900 and 390×900, not native iOS. The daemon supplies snapshot entries
by activity; web owns grouping and final ordering. Native iOS must apply the same
waiting-first comparator independently.

Build packages/web with `bun run build`. Pick a free port other than 8399 and a
fresh RUN from `mktemp -d /private/tmp/hyperneo-8909-XXXXXX`, then create RUN/home.
From the worktree root:

```sh
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/waiting-card-order-seed.ts "$RUN"
.claude/skills/verify/launch.sh "$PORT" "$RUN"
.claude/skills/verify/doctor.sh "$PORT" "$RUN"
NODE_PATH=<known-playwright-node_modules> VERIFY_BROWSER=<known-Chromium-executable> \
  node .claude/skills/verify/waiting-card-order-web.mjs "$PORT" "$RUN" before
```

Keep the launch process alive. Run `before` before the production fix, and `after`
after rebuilding web. The seed creates seven synthetic cards: three waiting on a
human (including one with a blocked todo), blocked work, running work, queued work,
and finished work. The two newest waiting cards have equal creation timestamps.

The browser helper opens the mobile work sheet, records card IDs in rendered
order, screenshots each viewport, and uses the seed's guarded update mode to
change only an older fixture card's outcome/activity time. It reloads the actual
snapshot and records the resulting order. No model runs or production DB writes.
Before proves in-progress blocked work precedes some waiting cards. After requires
all waiting cards first, creation time descending, ID ascending for equal times,
and the previous order for everything else. The unrelated outcome update and
reload must leave the order unchanged. Neither viewport may overflow horizontally.

Inspect evidence/{before,after}/waiting-order-{1280,390}.png and waiting-order.json.
Component coverage also changes snapshot input order and moves a waiting card back
to doing, asserting the visible card order after each live rerender. A failed
assertion or unreadable/clipped screenshot fails the journey.

Stop only the owned run with stop.sh. Preserve evidence outside the run directory
before removing synthetic daemon data, as required by the shared cleanup rules.
