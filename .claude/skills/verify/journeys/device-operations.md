# Every device operation answers over RPC

Calls each `device.*` and `device.pair.*` operation on a real isolated daemon. Use it
when one of them changes. It stops with a non-zero exit at the first failed call, and
diffs the whole transcript against the expected one below, exiting non-zero on any difference.
It also fails when the daemon does not shut down cleanly (a non-zero exit, or no
`Graceful shutdown complete` in its log), and keeps the run with its `daemon.log` whenever it fails.
Every request has a deadline: a daemon that never answers HTTP fails as `daemon not ready`,
and one still running 15s after TERM is reported by pid and left with its run for you to stop.
The RPC helpers run in the scrubbed environment, so a `VERIFY_CREDENTIAL` or `VERIFY_ORIGIN`
left in your shell is ignored.
The second command proves the RPC check: it renames the `device.list` call to an unknown
operation, so the daemon's error reply goes through the same outcome check as every call. It
passes only if that check printed `RPC error`, the journey stopped at that step and the daemon
still shut down cleanly. It first checks that a run refused before any RPC (port 8399) does not count.

```bash
.claude/skills/verify/device-operations.sh 9337
.claude/skills/verify/device-operations-fails.sh 9338
```

Expect:

- `device.pair.create` from the paired laptop is `ok approval=approved`; `device.pair.pending` lists 2.
- `device.pair.approve` and the first `device.pair.deny` are `ok`; the second deny is `refused: not_pending`.
- Terminal approval reads `enabled=True`, the terminal turns it off, cannot turn it back on
  (`refused: not_paired`), and the laptop can.
- `device.list` returns 3 devices; the two diagnostics return 0 rows; `device.pair.reset_lockout`
  and `device.revoke` are `ok`, leaving 1 revoked row.
- The first command ends with `device operations: transcript matches`; the second with
  `failure check: ok`. Both exit 0.

The script owns its daemon and removes its run directory only after a clean pass. It prints
no codes or credentials. The failure check removes the run its broken journey kept once the
check passes.
