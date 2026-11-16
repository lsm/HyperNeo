# Every device operation answers over RPC

Calls each `device.*` and `device.pair.*` operation on a real isolated daemon. Use it
when one of them changes; run it on the base too, the two outputs must match.

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/device-operations.sh 9337
```

Expect:

- `device.pair.create` from the paired laptop is `ok approval=approved`; `device.pair.pending` lists 2.
- `device.pair.approve` and the first `device.pair.deny` are `ok`; the second deny is `refused: not_pending`.
- Terminal approval reads `enabled=True`, the terminal turns it off, cannot turn it back on
  (`refused: not_paired`), and the laptop can.
- `device.list` returns 3 devices; the two diagnostics return 0 rows; `device.pair.reset_lockout`
  and `device.revoke` are `ok`, leaving 1 revoked row.

The script owns its daemon and removes its run directory on exit. It prints no codes
or credentials.
