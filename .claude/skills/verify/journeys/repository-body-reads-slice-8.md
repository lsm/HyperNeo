### Repository body reads (slice 8)

Use a fresh synthetic fixture, never a live DB or a copy. Unit suites run in CI.
This journey exercises the same `message.sdkMessages` and `message.sdkMessage`
RPC doors used to load a transcript and an individual full message. It does not
drive the GUI or start a model turn. It uses the real repository, daemon and
WebSocket transport, without the mock API or a provider key.

```bash
RUN=$(mktemp -d /private/tmp/hn-body-read-door-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/sdk-live-query-filters.ts seed "$RUN"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/sdk-body-repository-door.ts verify 9334 "$RUN"
```

The seed writes 55,014 rows through production derivation and dual write, with
`replacement_metadata_normalized=1` as production writers do. The helper first
loads both RPC responses, then blanks only the newest 500 synthetic legacy body
columns whose side bodies exist. Both responses must remain identical, including
background metadata and subagent messages, and remain identical after restart.
The complete logical-body SHA-256 must match before/after; tool results remain
stored in full. Full-body hashing and synthetic mutation happen outside latency
measurement, while startup/restart and RPC reads have separate lag measurements.
`observed.json` records executed SQL, query plans, RPC times and max event-loop lag;
SQL executions must be below 250 ms and measured lag below 1 s. Startup SQL is
not individually instrumented. Both daemon instances close in `finally`.

On the contract-test commit before the read wiring, use `reproduce` instead of
`verify` in a separate fresh run. `reproduction.json` records the wrong returned
transcript (`unknown` with empty content on that code), or a read error; neither
is a pass. Do not reuse that modified fixture for the fixed-code acceptance run.
GUI rendering, external drivers and the remaining live-query body outputs belong
to other journeys/slice 9 and are not verified by this repository-read journey.
