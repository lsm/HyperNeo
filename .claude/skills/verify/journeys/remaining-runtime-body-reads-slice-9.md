### Remaining runtime body reads (slice 9)

Run the registered daemon RPC and live subscriptions against split-only bodies:

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-runtime-bodies-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-live-query-filters.ts seed "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-runtime-door.ts verify 9336 "$RUN"
```

Use a free non-8399 port and a fresh run directory. The shared 55,014-row synthetic
seed uses production derivation, dual writes and `replacement_metadata_normalized=1`.
The helper adds only synthetic prompt, result and scoped group fixtures. It observes
full/compact transcript and task feeds, the active-turn roster, session groups,
message RPCs, adapter result/input/exchange reads and a scoped SQL body read. Outbox
verification accepts the original long prompt and rejects conflicting text.

It then blanks only the synthetic legacy bodies with existing side copies, notifies
subscriptions, and compares every output before/after and after daemon restart.
Full logical-body SHA-256 must remain identical, including every complete tool
result. `evidence/observed.json` records replies, snapshots, SQL times and heartbeat
lag against the 250 ms / 1,000 ms goals. Hashing, corpus creation and synthetic
blanking are outside measured hot reads; startup lag is measured separately.
`evidence/plans.json` records the actual session-feed and background-metadata plans;
both must hydrate selected rowids with joins and contain no correlated subquery.
Repeat with `reproduce` on pre-slice-9 code in a separate fresh directory/port:
`reproduction.json` records missing output or the legacy parser error. A baseline
RPC/setup failure is inconclusive, not a successful reproduction.

The helper closes both daemon instances and WebSockets in `finally`. It uses no
model, provider, real DB, credential file or GUI; UI rendering and deployment
performance are not verified. Unit contracts and unchanged historical pins run
in CI. Historical schema SQL and the dual-write copy are intentional legacy
readers until the later migration/removal slices.
