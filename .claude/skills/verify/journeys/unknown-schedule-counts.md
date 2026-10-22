### Unknown schedule counts

On another fresh run, seed with `session-schedule-web.ts`, then run the headless
`session-schedule-summary.mjs <port> "$RUN"` with the same Node/Playwright setup.
It holds and refuses only the first schedule-list reply at the WebSocket boundary;
all other calls and the successful retry use the actual isolated daemon. While the
strip is collapsed, both pending and failed reads must show the title “Schedules”
without a fabricated zero, alongside the explicit “more” control. Title clicks
leave it collapsed. Enter on “more — Schedules” opens the strip; use the visible
“Refresh schedules” button and wait for it to become enabled after the real reply.
Space on “less — Schedules” collapses it again, showing the actual count of two.
The helper reads the title span independently from the shared control label.
Component contracts separately check a successful empty read shows zero.

Evidence: `evidence/schedule-summary.json` and
`schedule-summary-{loading,failed,recovered}.png`. This is controlled fault
injection into the real web surface, not a claim that the daemon itself failed.
For a persistent Playwright session, import `verifyScheduleSummary` from the helper
and call it with an owned page and `{ port, run }`; close that context afterward.
The CLI wrapper closes its headless browser. Stop the daemon/mock with `stop.sh`.
