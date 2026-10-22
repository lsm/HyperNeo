## Every connection is accepted; unpaired ones are recorded (S2 of docs/design/daemon-security.md)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399):

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/upgrade-auth-report.sh 9315
```

The script starts an isolated daemon through the CLI front door (`env -i`,
NODE_ENV=test, its own HOME, data dir and database, no provider key). It pairs a relay
with `hyperneo pair` and `POST /pair`, then calls read-only `client.list` over `/ws`
four times:
unpaired, with the relay's Bearer credential (`VERIFY_CREDENTIAL`), with a foreign
browser Origin (`VERIFY_ORIGIN`), and with an unknown credential. Credentials stay in
shell variables.

End state:
- All four `client.list` calls answer `served=True` in similar times. Pending-code
  management is separately restricted to active paired humans; this transport
  report probe must not use `device.pair.pending`.
- `unpaired_connections` holds three rows (native, browser `https://evil.example`,
  and native with `credential_rejected` 1), each with host and remote address. The
  paired relay adds no row.
- The relay's `last_seen_host` is the daemon's host.
- The credential appears 0 times in the database dump and the daemon log.
