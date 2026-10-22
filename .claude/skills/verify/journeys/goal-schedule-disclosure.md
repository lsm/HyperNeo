# Explicit goal, journal and schedule controls (#8099)

Use the shared isolated setup, fresh HOME/data/DB, NODE_ENV=test and a free port
other than 8399. Build the web first, launch with `launch.sh`, then run the existing
`goal-detail-web.ts "$PORT" "$RUN"` seed. This creates a synthetic local Git home
and local bare origin rewrite, goal/schedule and 21 journal records through RPC;
only its synthetic what-works note is a direct DB fixture. No real provider,
credentials, GitHub network request or live DB is used.

Use persistent headless Playwright at 1280x1000 and 390x1000, with a five-second
locator timeout. Import `goal-schedule-disclosure-web.mjs` beside the skill and
call `verifyGoalSchedule(page, {port, run, width, phase})` for both widths. Phase
before records the reproduction; phase after enforces explicit-control behavior.
The helper writes JSON and viewport PNGs under `$RUN/evidence/<phase>/`.

| Surface / claim | Check / evidence |
| --- | --- |
| Schedules strip | Summary click stays closed; more opens and less closes; final control stays below its content; schedule definition/journal/footer screenshots |
| Schedule-owned goal | Title click makes no detail visible; explicit more/Enter opens the scoped goal; text clicks stay inert; less/Space closes; footer bounds |
| Goals card | Your work on phone; title/status stay inert; same explicit control reveals definition and collapses after content; goals screenshots |
| Journal entry | Effect summary stays inert; more opens action, worked/failed and PR evidence; body click does not close; collapse follows evidence |
| Paging | All 21 entry IDs stay newest-first after Older entries; the open newest entry stays open after page append; JSON IDs |
| Existing content | Metrics, done-test, next steps, what-works, origin/revision mandate href and real PR href remain intact; definition and journal screenshots |
| Layout | Right-edge bounds and no horizontal overflow at both widths; inspect screenshots separately, including internal strip/work-panel scrolling |

For pause/resume, call the helper's `changeGoalSchedule(page, {port, run,
paused:true})`, then run the read-only checker:

```sh
bun .claude/skills/verify/goal-schedule-disclosure-state.ts "$PORT" "$RUN" paused
```

Repeat with paused:false and checker argument active. The UI must change its
button/status, leave goal details closed, and real schedule.session.list must
report the persisted status. Evidence: schedule-paused/active.png and
schedule-state-paused/active.json. Never point this checker at a live daemon.

Component contracts cover unavailable reads, loading/unknown counts, translated
labels, read-only pause, refresh, retry, stale-owner responses and retaining the
same goal-control DOM button across expansion. Existing goal-detail and schedule
journey helpers now use explicit controls rather than title/summary activation.
This journey proves the new controls plus actual goal/journal reads and schedule
mutation persistence. Native iOS, real providers, wake execution and the older
Space-session boundary/long refresh browser scenarios are not claimed rerun here.

Close the browser and stop only this run with `stop.sh "$RUN"`. Keep evidence for
review. Shared SKILL.md and indexes are unchanged.
