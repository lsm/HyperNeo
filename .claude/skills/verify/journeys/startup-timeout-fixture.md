# Startup timeout tests reach the SDK timeout

Use SKILL.md's resource and isolation rules. This wrapper owns a local model
mock on a free ephemeral port, an isolated test HOME/data directory, and the
online test's in-process daemon. It does not use ports 8000 or 8399. No parent
credentials are inherited. The existing online harness supplies only its
synthetic loopback provider credential. SDK subprocesses are deliberately silent
Node processes; this does not verify the upstream CLI or OS sandbox enforcement.

```sh
python3 .claude/skills/verify/startup-timeout-fixture.py <absolute-fresh-evidence-dir>
```

The fixture delays real query-options preparation by 25 ms before returning the
silent process launcher. With the former 10 ms shared preparation/startup limit,
preparation times out before the SDK process starts. Keep that failing
reproduction separately; do not accept a generic preparation error as SDK startup
coverage. With the two-second fixture window, public message.send and state.session
must show three owned SDK starts with the shared backoff, the original delivered
user prompt, and a persisted failed episode containing the startup timeout. The
public terminal error must say the shared three-failure cap was reached, return
idle, and permit no fourth start after a further observation window. The old
two-attempt local ceiling was the producer defect fixed by #9130.

Require exit zero and retain proof.log, mock.log and run-status.json. The wrapper
stops its own model listener, the tests close their daemon and owned subprocesses,
and temporary HOME/data are removed on exit. No browser or real-provider behavior
is verified here.
