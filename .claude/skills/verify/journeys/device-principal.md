## A paired device calls by its kind, and only a paired human device can Allow (S3 of docs/design/daemon-security.md)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399):

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/device-principal.sh 9316
```

The script starts an isolated daemon through the CLI front door (`env -i`,
NODE_ENV=test, its own HOME, data dir and database, no provider key). It pairs a relay
and then a phone from the CLI, makes a second human code, and calls operations over
`/ws` unpaired, as the relay and as the phone. Credentials and codes stay in shell
variables.

End state:
- The first human code from the CLI is `approved` even though a relay is already
  paired: the human can always pair a first human device from the Mac.
- The unpaired client still calls `device.pair.pending`: nothing changes for unpaired
  connections.
- The relay calls `client.list` and `neo.snapshot` (what the push relay reads) and is
  refused `device.pair.pending` with "not available to this caller".
- The second human code is `pending`; redeeming it answers `awaiting_approval`.
- Allow from an unpaired browser answers `not_paired: only a paired human device can
  allow a code. Allow it on the phone or browser you paired first.`
- Allow from the paired phone answers `ok`, and the code then pairs `Laptop`.
- A lost phone is recovered from the Mac: `hyperneo pair --reset-human` answers
  `unpaired=2`, the old phone's Allow is then refused with `not_paired`, and the next
  human code from the CLI is `approved` again.
- Neither credential appears in the database dump or the daemon log.
