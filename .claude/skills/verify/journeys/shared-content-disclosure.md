# Shared bottom-right content disclosure

Use the shared setup with a fresh synthetic run, never port 8399 or a live DB.
Build `packages/web`, create `$RUN/home`, then seed before daemon startup:

```sh
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/shared-disclosure-seed.ts "$RUN"
.claude/skills/verify/launch.sh "$PORT" "$RUN"
```

Keep the launch terminal alive. The seed reuses the synthetic todo fixture and
adds two publications with short/long final lines, a long human message and an
answered question. No model, credentials, real transcript or remote fetch is used.

Use persistent headless Playwright and import `shared-disclosure-web.mjs` from
`.claude/skills/verify/`. Call its exported
`verifySharedDisclosure(page, {port, run, width, phase})` with widths 1280 and 390.
Use phase `before` on the failing reproduction, then `after` after rebuilding.
Every browser context must start with fresh session storage for the first run.

The helper records real `/neo` button and paragraph bounds, screenshots and JSON
under `$RUN/evidence/{before,after}/`. Both short and long publication endings
must keep more/less at the right edge in both states, sharing the final line when
space remains and moving to the next right-aligned line when it does not. Inspect
these screenshots separately from the assertions. Tables/code/list endings can
use their own right-aligned final line. Clamped human messages keep a visible
explicit control. The todo title/body must never toggle on click; only its
explicit control does. Historical question Details remain readable and closable.
Check body-text dragging selects text without collapsing, Enter/Space work on the
control, and no horizontal overflow occurs at either width. Every contextual accessible name must include the visible more/less word so voice commands can find it. Shared component contracts cover English and Chinese in both states.

This slice covers primary Neo publication, clamped message, todo and card-history
controls. Other existing content disclosures are inventoried in issue #8092 for
follow-up replacements using the same shared control. Menus, navigation trees,
model pickers and bulk Expand all/Collapse all are separate structural actions.

Close the browser and stop only this run with `stop.sh "$RUN"`. Retain before and
after evidence for review. Native iOS is handled separately and is not verified.
