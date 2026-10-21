## Device pairing (S1 of docs/design/daemon-security.md)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399):

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/pair-device.sh 9314
```

The script starts an isolated daemon (`env -i`, NODE_ENV=test, its own HOME, data
dir and database, no provider key) through the CLI front door. It pairs devices with
`hyperneo pair` over the run's session socket and `POST /pair`, and prints statuses
and kinds only: codes and credentials stay in shell variables.

End state:
- The first CLI code is `approved` and pairs (`200 human`, 43-char credential).
- The second CLI code is `pending`: `POST /pair` answers `403 awaiting_approval`
  until `device.pair.approve`, then `200`; the used code then answers `401`.
- Bad codes: `401` until 5 failures in the minute (the used-code retry counts),
  then `429`; `hyperneo pair --reset-lockout` reopens pairing.
- `paired_devices` holds `Laptop:human, Phone:human`; the raw credential appears
  0 times in the database dump, and the pairing code 0 times in the daemon log.
- An unpaired WebSocket is still served (nothing is enforced in S1).
