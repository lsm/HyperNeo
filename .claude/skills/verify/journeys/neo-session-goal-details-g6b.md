# Session goal details (G6b)

Run all commands from the worktree root. Use the [shared setup](../SKILL.md) to
build the web and launch a fresh isolated daemon. Helpers remain in
`.claude/skills/verify/`; only this recipe lives under `journeys/`. Run
`bun .claude/skills/verify/goal-detail-web.ts <port> "$RUN"`, followed by the
headless `.claude/skills/verify/goal-detail-web.mjs <port> "$RUN"` with a Node
runtime that resolves Playwright. Set `NODE_PATH` to its module directory when
needed; `VERIFY_BROWSER` may select a local Chromium executable, always launched
headless with a fresh profile. The helper creates a synthetic local home git
repository whose GitHub-style origin is served from a local bare clone through a
repo-local `core.sshCommand` (no network), tracked so home reads can sync, plus a
session goal and 21 journal entries through actual RPC. Only
works_note is seeded directly in the synthetic DB: G8 owns its write/compaction.

Open `/neo` at 1280/390px and test both entry points: expand Schedules and select
the goal title, then open the title in Goals (inside Your work on mobile). Metrics,
done-test, next steps and what-works must be visible. Its mandate link must match
the synthetic origin and recorded revision; no external navigation is performed.
Load older journal entries: all 21 must remain newest-first, with entry-id paging,
and opening the newest entry must show its action, worked/failed text and actual
PR evidence href. Inspect `evidence/goal-definition-{schedule,goals}-{1280,390}.png`,
`goal-detail-{schedule,goals}-{1280,390}.png` and
`goal-detail-web.json`; long content scrolls inside the schedule strip or work panel.

Component contracts cover page-read failure/retry, stale selection, no-remote text
and non-web evidence. Daemon contracts cover the read-only worksNote projection
and opt-in home remote metadata (no userinfo; local remotes remain null). Ordinary
home reads retain their old shape and do not fetch remotes. This proves real read
RPCs and headless rendering, not G8 compaction or external hosting. The browser
closes itself; stop the isolated daemon/mock with `.claude/skills/verify/stop.sh "$RUN"`.

### Goal detail read states

On a fresh synthetic goal-detail seed, run the headless
`.claude/skills/verify/goal-detail-review.mjs <port> "$RUN"`. It updates the goal
through actual RPC with a null metric and a missing mandate document. The browser delays only the
first full journal read; the response itself and every other RPC use the real
isolated daemon. Pending journal reads must show loading without Retry. Once
released, entries appear, unknown metrics use an em dash (zero/false stay intact),
and a refused optional home read leaves the loaded goal readable with a plain
mandate reference and no goal-error alert. Inspect `goal-review.json`,
`goal-review-loading.png` and `goal-review-metadata.png`. Component contracts also
cover an optional metadata transport fault and retry after a failed first page.
The helper closes its browser; stop the daemon/mock with `.claude/skills/verify/stop.sh "$RUN"`.
