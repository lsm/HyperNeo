## A daemon attaches to another with a pairing code; the other lists and revokes it (S5 of docs/design/daemon-security.md)

Build the web bundle first (`cd packages/web && bun run build`), then run on two free
ports (never 8399):

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/attach-paired-daemon.sh 9317 9318
```

The script starts two isolated daemons, A and B, through the CLI front door (`env -i`,
NODE_ENV=test, each with its own HOME, data dir and database, no provider key). B makes
a daemon pairing code with `hyperneo pair --kind daemon`; A attaches to B with it over
`daemon.attach`, forwards a message, and B then lists and revokes A with
`hyperneo devices` and `hyperneo devices revoke`. Codes and credentials stay in shell
variables.

End state:
- `daemon.attach` with B's code answers `attached`; a wrong code answers
  `pairing refused (401 invalid_code)` and attaches nothing.
- A forward reaches B (`Unknown session: no-such-session` is B's own answer).
- B lists one `daemon` device named `HyperNeo on <A's host>` with a last-seen host.
- A holds one row in `remote_daemon_secrets`; its settings list the attachment `b`,
  and the credential appears 0 times in A's `daemon.list`, A's settings, or either log.
- After the revoke, the next forward still reaches B, which records it as an unpaired
  native connection with a rejected credential (nothing is refused until S8).
- With its only device revoked, B's CLI refuses a human code with `no_human_device`:
  revoking never reopens pairing without Allow.
