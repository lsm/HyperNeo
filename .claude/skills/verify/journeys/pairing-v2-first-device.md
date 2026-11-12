# Pairing v2 first phone and later approvals

Run `pairing-v2-first-device.ts` through `proof-run.sh` with pinned Bun and the
checkout head. It owns a fresh test HOME, database, daemon and random loopback
port, uses synthetic Ed25519 keys and saves no tickets, credentials or cookies.

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/pairing-v2-first-device.ts "$(git rev-parse HEAD)"
```

Drive `/pair2/request`, `/pair2/bind`, `/pair2/approve` and `/pair2/complete` over
the daemon's own HTTP host transport, through the real authenticated door, not
the repository directly. A fresh daemon has no paired phone: the first ticket
must complete straight after the scan with no approval call, and must receive
the owner bit. The approve route must refuse that first-device request once a
phone exists, and completing it afterwards must report `cancelled`.

Then pair a second phone as a later device. It must need approval, and the first
phone must be able to approve it. A deposited legacy typed-code device must be
able to approve a v2 phone as well. Require the grant to leave four active
phones.

Close sockets and the daemon, retain `pairing-v2-first-device.json` with
`passed` and `resourcesClosed`, require wrapper exit 0 and remove temporary
data. The iOS scanner, comparison digits and the pending list are outside this
proof.
