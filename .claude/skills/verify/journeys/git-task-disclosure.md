# Explicit Git and task-kickoff controls (#8104)

Use the shared isolated setup, fresh HOME/data/DB and free ports other than8399.
Build web first. No model or provider credential is required. The Git workspace,
completed Space task and consumed kickoff are synthetic; no task is dispatched.

```sh
RUN=$(mktemp -d /private/tmp/hn-git-task-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/git-task-disclosure-seed.ts "$RUN"
VERIFY_GH_STUB=git-task-gh-stub.sh .claude/skills/verify/launch.sh 9396 "$RUN"
```

Keep the owning terminal alive. Run `doctor.sh 9396 "$RUN"`. The fixture uses
actual Git diff/status reads in a temporary repository (700 added lines exceed
the 24k preview limit) and actual task-message LiveQuery reads. Its gh stub serves
only synthetic PR/check metadata from the run directory and logs calls; it never
contacts GitHub. Check links point to example.invalid; inspect hrefs without
opening them. Auth/credential files and the live daemon are never read.

In persistent headless Playwright with en-US locale and five-second locator
timeouts, import `git-task-disclosure-web.mjs` and call
`verifyGitTask(page, {run, port:9396, width, phase})` for1280 and390 widths.
Use before on original controls, after on the rebuilt fix. For a reproducible
before build, use a separate owned worktree at
`dc2a30e06d6dcab1052122a5feb4419f459f9994`, install frozen dependencies there and
build its web package. Run the current seed helper from the PR checkout, copy
its `git-task-gh-stub.sh` into that original checkout's verify directory, then
launch from the original checkout against the seeded run. Import the **current**
`git-task-disclosure-web.mjs` from the PR checkout for both phases. It records
`diffControl: null` before because there is no collapse control; the after phase
asserts the actual footer bounds. Stop that daemon before launching the rebuilt
PR checkout with a fresh run. Keep the original checkout's revision and the
helper SHA256 alongside the evidence; remove the owned before worktree after
preserving its evidence and the copied fixture. JSON and six PNGs
per width/phase go into `<run>/evidence/`.

| Surface / claim | Observable check |
| --- | --- |
| Actual session inspector → Changes | Check title stays inert, more/Enter opens, less/Space closes; CI names/statuses and links survive; control follows the last check at the right edge |
| Selected big.txt diff | Actual git.fileDiff loads the synthetic final line; body click does not close; less returns to truncated preview; focus survives; warning and control follow the diff at the visible right edge |
| Selected file | Switching to small.txt reads its diff and removes full-diff controls; switching back to big.txt restores preview; existing file-copy/editor links are untouched |
| Actual completed Space task | Title stays inert; more/Enter opens full Markdown; after async Markdown hydration focus is still on less; body click/drag selects without closing; less/Space closes and returns focus |
| Rendering | Inspect before/after desktop and phone screenshots separately, including the panel's internal scrolling and footer position; long diff lines keep horizontal scrolling within the diff |
| Component contracts | Loading disables more and announces status; failed reads remain retryable; null patch response still offers less; stale responses are ignored, unchanged polls preserve open content; task delivery badges and ordinary messages survive |

The main browser proof exercises successful actual Git/RPC reads. Retry, nullable
responses, stale-request cancellation and failed/queued task badges are component
contracts, not live-provider failure claims. Native iOS, real GitHub/provider
traffic, clipboard permissions and task execution are not covered.

Stop only this run with `stop.sh "$RUN"`, close the owned browser and let the
owning terminal exit. Retain the synthetic DB/repo. Copy doctor, JSON, PNGs and
test/check output into the PR. Keep shared SKILL.md and indexes unchanged.
