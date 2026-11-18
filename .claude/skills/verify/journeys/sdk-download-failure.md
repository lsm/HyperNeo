# A failed Claude Code download has one cause and a download-only retry

Build the compiled binary for this checkout. Follow the isolation and resource
checks in SKILL.md, then run `sdk-download-failure.sh` once with `connection`
once with `html`, and once with `slow`, each with a fresh absolute run directory and free ports:

```bash
.claude/skills/verify/sdk-download-failure.sh "$BIN" "$RUN" 9427 9428 connection
```

The helper starts the daemon with its own HOME and data directory, a loopback
model mock, and isolated fake package managers and curl that cannot access the network. It sends a session
message, checks the public session state for the package download cause and no
query failure, then invokes the retry operation once. Pass requires one extra fake download call for failed downloads, an unchanged
message snapshot, an idle session, and a plain failure response. The slow
fixture is still running at the 45-second wait limit; retry joins that download
without a second download call, then reports its failure. Evidence is in `$RUN/evidence/`. Retain evidence outside the
run and remove the synthetic data after the owned processes exit.
