# Explicit error/workflow details (#8103)

Use the shared isolated setup. This journey needs no provider turn or key. Build
web first, choose free ports (9396 and mock 8000 below), and create a fresh run:

```sh
RUN=$(mktemp -d /private/tmp/hn-error-workflow-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/error-workflow-seed.ts "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/error-workflow-server.ts "$RUN" 9396
```

The seed refuses an existing DB, creates only synthetic records and retains the
built-in workflows. The server publishes one structured session.error through the
actual daemon event bus, then serves the production web build with the real
WebSocket/RPC handlers. The error enters the ordinary session-state projection
and ErrorBanner → View Details → ErrorDialog path. This avoids a provider failure
or a mocked frontend response. It starts its own HTTP mock for doctor only.
Keep the owning shell alive; do not launch a second daemon on those ports.

Run doctor with `doctor.sh 9396 "$RUN"`. In persistent headless Playwright,
import `error-workflow-web.mjs` and call
`verifyErrorWorkflow(page, {run, port:9396, width, phase})` at 1280 and 390,
with locale en-US and five-second locator timeouts. Use phase before on the
original implementation, after on the rebuilt fix. The helper writes screenshots
and measured JSON to `<run>/evidence/`.

| Surface / claim | Observable check |
| --- | --- |
| ErrorDialog Technical Details | Title click stays closed; explicit more/Enter opens; body click and drag select text without closing; less/Space closes; focus follows the moved control |
| Error details | Long message, metadata, recovery flag and stack remain present; less follows all technical content at the right edge; Copy Error Report and Close remain available |
| Space workflow requirements | Open Space settings, then Runtime tab; on phone use Open navigation menu, Space settings, then Close panel before Runtime |
| Workflow details | Level 3 count remains 5 of 7; count/title stay inert, more/Enter reveals synthetic blocked and built-in Coder-Only requirements; less/Space closes; focus survives both moves |
| Layout | Inspect desktop/phone closed and expanded screenshots separately; right-edge bounds, footer below requirements, no horizontal document overflow |
| Component contracts | Controlled callbacks, default-open state, height animation, empty/all-autonomous workflow behavior and aria-controls relationships survive |

Space overview does not fetch workflows on a cold visit at this revision; the
Runtime tab is the verified active caller. Do not claim fresh-overview coverage.
Technical content stays mounted for the existing height transition: use the
control's aria-expanded plus the height/screenshot, not innerText alone, to
judge closed state. The helper waits for height to settle before dragging text.
Native iOS, clipboard permission behavior, real providers and task execution are
not covered by this journey. The main journey changes no settings. For the review regression, call
`verifyEmptyWorkflowFooter(page, {run, port:9396, width, phase})` at both widths,
with phase review-before/review-after. Expand workflow details, choose level 5 in
the local settings draft (do not Save Changes), and check that only the count
remains: no blank footer or added vertical gap. Restore level 3 and confirm the
returning details can still collapse. The helper restores the draft before exit;
no setting is persisted. Component cases also cover a workflow-list update.

Close the owned browser, then Ctrl-C the server's owning shell. Its signal handler
stops only its own daemon and mock and waits for cleanup. Preserve the synthetic
DB/evidence; copy JSON, PNGs and doctor output into the PR. Shared SKILL.md and
indexes are unchanged.
