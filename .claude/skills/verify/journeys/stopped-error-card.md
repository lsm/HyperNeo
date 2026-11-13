# A stopped query shows once, inside its API Error card

Use SKILL.md isolation, resource checks and launch/stop in one owning shell.
Build web first. Launch with `VERIFY_MOCK=mock-api-overloaded.ts`: that mock
answers every model request with 529 overloaded and `x-should-retry: false`,
so each turn ends at once with an API Error card. Give the run the dev-proxy
provider over RPC as SKILL.md shows, then run:

```bash
VERIFY_MOCK=mock-api-overloaded.ts .claude/skills/verify/launch.sh "$PORT" "$RUN"
node .claude/skills/verify/stopped-error-card-web.mjs "$RUN" "$PORT" after
```

The helper creates a session, pairs a 390px headless browser, and sends three
messages through the composer. The third error result reaches the query
failure cap, and the daemon emits "Query stopped after 3 failures".

Pass (`after`): in dark and light, no top error banner; the last API Error card
says "Stopped after 3 failures. Send a message to recover."; its raw error sits
behind a closed "Technical details" toggle that opens on click; the page does
not scroll sideways. `before` against an older build expects the duplicate
banner instead. Screenshots and `stopped-error-<mode>.json` land in
`$RUN/evidence`. Other banners (local send errors, retry status, re-auth or
switch-provider actions) are not driven here; the unit tests cover that choice.
