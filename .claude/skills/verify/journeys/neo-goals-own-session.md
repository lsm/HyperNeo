# Goals tab lists goals that run in their own session

Build the web app, launch a fresh isolated daemon with `launch.sh`, export
`HYPERNEO_DATA_DIR="$RUN/data"`, then run the headless helper with the same
Node/Playwright/VERIFY_BROWSER setup as the other web journeys:

```sh
node .claude/skills/verify/neo-goals-own-session-web.mjs <port> "$RUN" after
```

Through real RPC it opens root Neo and creates one ordinary hourly goal and one
hourly goal with `ownSession: true`, which the daemon gives a new child session
of Neo as owner. It pairs a browser through `POST /pair`, opens `/neo`, and
selects the Goals tab. No provider is configured and no model is called.

Both goals must be listed, and the own-session goal's next wake must equal
`nextRunAt` from `schedule.session.list` on its child owner session. Check
`evidence/neo-goals-own-session-<label>.json` (`passed: true`) and the matching
screenshot. Before the fix the tab showed only the ordinary goal and the helper
fails with "The own-session goal must be listed on the Goals tab". Stop the
daemon and mock with `stop.sh`.
