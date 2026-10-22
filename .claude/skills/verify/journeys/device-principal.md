## A paired device calls by its kind, and only a paired human device can Allow (S3 of docs/design/daemon-security.md)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399):

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/device-principal.sh 9316
```

The script starts an isolated daemon through the CLI front door (`env -i`,
NODE_ENV=test, its own HOME, data dir and database, no provider key). It pairs a phone
from the CLI, then a relay that the phone allows, makes a second human code, and calls operations over
`/ws` unpaired, as the relay and as the phone. Credentials and codes stay in shell
variables.

End state:
- The first code from the CLI, with nothing paired, is `approved`. The relay code
  made after that is `pending`, and the paired phone's Allow answers `ok`. (With only
  a relay paired, the CLI refuses human codes with `no_human_device: … Pair the phone
  first`; a unit test covers it.)
- The unpaired client is refused `device.pair.pending`: only an active paired
  human can manage pending codes; an unpaired client gets no self-approval list.
- The relay calls `client.list` and `neo.snapshot` (what the push relay reads) and is
  refused `device.pair.pending` with "not available to this caller".
- The second human code is `pending`; redeeming it answers `awaiting_approval`.
- Allow from an unpaired browser answers `not_paired: only a paired human device can
  allow a code. Allow it on the phone or browser you paired first.`
- Allow from the paired phone answers `ok`, and the code then pairs `Laptop`.
- Neither credential appears in the database dump or the daemon log.
