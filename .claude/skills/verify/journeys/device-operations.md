# Every device operation answers over RPC

Calls each `device.*` and `device.pair.*` operation on a real isolated daemon. Use it
when one of them changes. It stops with a non-zero exit at the first failed call, and
diffs the whole transcript against the expected one below, exiting non-zero on any difference.
The second command proves that: it breaks the `device.list` call and passes only if the
journey then fails.

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

The script owns its daemon and removes its run directory on exit. It prints no codes
or credentials.
