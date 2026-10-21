## SDK adapter/runtime filter journey

Use `sdk-runtime-filters.ts seed "$RUN"`, then `measure "$RUN" before` on dev
before the filter change. Use `NODE_ENV=test`, a clean temporary HOME and
`env -i` as in Launch. It seeds 55,002 synthetic messages through the production
derivation, including full large tool results, with
`replacement_metadata_normalized=1`. Run `measure "$RUN" after` on the branch,
then repeat as `measure "$RUN" restart`. Keep receipts, body hashes, query plans,
per-query times and separate startup/query maximum event-loop lag. Compare
the first index upgrade and completed restart separately against 1 s lag and
250 ms per query. No body is trimmed; a differing hash or exceeded budget fails
acceptance rather than being explained away.

Launch the isolated daemon on that run directory, run Doctor, then
`bash .claude/skills/verify/sdk-runtime-filters-door.sh <port> "$RUN"`.
End state: public `work.status` returns `runtime-filter-token`, the original
recent input and two ordered exchange entries, and `inputEvidence.state` is
`observed` for `last-human`. The helper compares these with the pre-change
receipts and saves both the RPC result and comparison. No provider or GUI is
needed. Keep the launch shell alive through Doctor and this helper if the
command executor stops background children when that shell exits; stop the
daemon and mock before ending the shell. Unit/contract suites run in CI.
