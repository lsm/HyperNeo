# Neo work-card todo disclosure

Use synthetic files and an isolated daemon. Never use port 8399 or the live database.
This journey covers web desktop and mobile; native iOS is outside its scope.

## Prepare

Build `packages/web` with `bun run build`. Choose a free daemon port and a fresh
run directory. Create its `home/`, then seed the database from the repository root:

```sh
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/neo-todo-collapse-seed.ts "$RUN"
.claude/skills/verify/launch.sh "$PORT" "$RUN"
```

Keep the launch terminal alive until verification finishes. The seed creates two
cards, including three todos with long synthetic status, report and evidence text.
The launcher owns only this run's daemon and SDK mock.

## Headless browser proof

Run `.claude/skills/verify/neo-todo-collapse-web.mjs` using Playwright against the
isolated daemon. It exports `verifyTodoCollapse(page, {port, run, width})` for the
persistent browser REPL. Alternatively, with Playwright resolvable through
`NODE_PATH`, run `node .claude/skills/verify/neo-todo-collapse-web.mjs "$PORT" "$RUN"`.
`VERIFY_BROWSER` can select an installed Chromium executable.

The script checks real `/neo` at desktop 1280×900 and mobile 390×900:

- Three rows start collapsed, each with title and one status line.
- Enter expands only the focused row, showing its report/evidence. Space closes it.
- Each row expands independently. The old bulk footer has been replaced by All;
  use neo-all-items-dialog.md for the current footer and history journey.
- The other card stays unchanged. Reload preserves the first card's chosen state.
- Collapsed status stays one line and neither viewport overflows horizontally.

Inspect initial, expanded and final PNGs under `$RUN/evidence/` for clipping,
readability and control placement. JSON files record assertions as they complete.
A failed assertion is a failed journey. Preserve baseline and final evidence in
separate directories when reproducing a bug.

Component coverage additionally checks fresh todos start collapsed, independent
card state survives remounts, Open remains separate from disclosure, Chinese labels
match iOS, and start-question checkbox rows keep their behavior.

## Cleanup

Close the browser contexts and run `.claude/skills/verify/stop.sh "$RUN"`. Save
evidence outside the run, then remove the disposable synthetic HOME/data.
