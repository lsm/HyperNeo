### Unknown schedule counts

On another fresh run, seed with `session-schedule-web.ts`, then run the headless
`session-schedule-summary.mjs <port> "$RUN"` with the same Node/Playwright setup.
It holds and refuses only the first schedule-list reply at the WebSocket boundary;
all other calls and the successful retry use the actual isolated daemon. While the
strip is collapsed, both pending and failed reads must show only “Schedules”,
without a fabricated zero. Retry must show the actual count of two. Component
contracts separately check a successful empty read shows zero.

Evidence: `evidence/schedule-summary.json` and
`schedule-summary-{loading,failed,recovered}.png`. This is controlled fault
injection into the real web surface, not a claim that the daemon itself failed.
The helper closes its headless browser; stop the daemon/mock with `stop.sh`.
