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
preparation times out before either SDK process starts. Keep that failing
reproduction separately; do not accept a generic preparation error as SDK startup
coverage. With the two-second fixture window, public message.send and state.session
must show the startup failure, return idle, and retain the actionable startup
message after exactly two owned SDK processes. The second case also checks that
no further error loop begins. Both original behavioral assertions remain active.

Require exit zero and retain proof.log, mock.log and run-status.json. The wrapper
stops its own model listener, the tests close their daemon and owned subprocesses,
and temporary HOME/data are removed on exit. No browser or real-provider behavior
is verified here.
