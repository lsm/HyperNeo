## Worker build query through the owner-only socket

Build web once, then use Launch with a fresh run and a free non-8399 port. No
provider or model turn is needed. Keep launch, check and stop in the same shell
so the shell runner does not reap the background daemon between calls:

```bash
RUN=$(mktemp -d /private/tmp/hn-build-XXXXXX)
trap '.claude/skills/verify/stop.sh "$RUN"' EXIT
.claude/skills/verify/launch.sh 9372 "$RUN"
env -i HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  bun .claude/skills/verify/build-check.ts "$RUN" "$(git rev-parse HEAD)"
```

The helper runs the real `hyperneo build` command through both source and release
CLI entries, checks that source `--help` lists `build`, and uses only
`<run>/data/session-door.sock` for the query. Release `--help` requires generated
embedded assets and is not exercised by this source-only journey. The worker sender is set
synthetically; normal workers inherit their session sender and socket location.
It verifies socket permissions 0600, daemon PID and build commit, stable process
startedAt (Unix milliseconds), increasing uptime (milliseconds), health `ok`, and
exactly the six public response fields. Every other registered operation plus an
unknown name and `system.health` must be denied by the socket itself; missing
sender must also be denied. `evidence/build-check.json` retains both CLI outputs
and denied names. Health means the daemon can answer and perform `SELECT 1`; it
does not claim provider availability. The socket contract suite covers probe
failure without leaking error text, and rejects extra response fields. No GUI,
real data, auth files or TCP 8399 are involved.
