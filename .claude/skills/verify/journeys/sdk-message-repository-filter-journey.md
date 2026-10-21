## SDK message repository filter journey

Run `NODE_ENV=test bun .claude/skills/verify/sdk-message-filters.ts seed "$RUN"`
on the pre-filter branch, then `measure "$RUN" before`. This generates 55,000
synthetic messages with full large tool results, production-derived columns and
`replacement_metadata_normalized=1`; it never copies a real database. Use an
empty temporary HOME and `env -i` as in Launch. On this branch, run
`measure "$RUN" after` against that same synthetic database. Initialization adds
the two typed eligibility columns and completes the existing backfill's v2 pass.
End state: receipt and full-body hashes match before/after, all per-query timings
stay below 250 ms and maximum event-loop lag stays below 1 s on this fixture.
Keep the logs and disclose any violation rather than calling it a pass.

Launch the isolated daemon on that run directory and run
`bash .claude/skills/verify/sdk-message-filters-door.sh <port> "$RUN"`.
It invokes `session.messages.byStatus` for consumed inputs.
End state: total 54,440, twenty messages in the original order, beginning with
`m-1` (the earlier `m-0` is a replayed tool result). Keep the RPC reply, compare
its ids/text/total to the synthetic repository receipt, then stop the daemon
and mock. Loading a session replays deferred input, so a live deferred count
cannot be compared to the offline receipt without controlling that lifecycle;
do not claim that check passed. Deferred selection is compared offline and
covered in CI. No GUI rendering is covered.
