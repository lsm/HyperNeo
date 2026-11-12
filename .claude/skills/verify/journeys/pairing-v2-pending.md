# Pairing v2 pending list and joining-phone cancel

Run `pairing-v2-pending.ts` through `proof-run.sh` with pinned Bun and the
checkout head. It owns a fresh test HOME, database, daemon and random loopback
port, uses synthetic Ed25519 keys and saves no tickets, credentials or cookies.

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/pairing-v2-pending.ts "$(git rev-parse HEAD)"
```

Drive `/pair2/request`, `/pair2/bind`, `/pair2/complete`, `/pair2/pending`,
`/pair2/cancel` and `/pair2/status` over the daemon's own HTTP host transport.
Pair a first phone, then bind a later-device ticket.

The paired phone's credential must read `GET /pair2/pending` and see exactly
that bound, unapproved request with `requestId`, `name`, `phoneKey`,
`bindNonce` and `expiresAt`, under `cache-control: no-store`. The web setup
credential must get 403 there.

The joining phone signs `cancel:requestId:bindNonce` with its bound key and
cancels without any caller credential. The request must then be terminal: status
reports `cancelled` and completion is refused. A forged signature sent with a
paired phone's credential must be refused, so a signed cancel never falls back
to the approver path. Require one active human phone at the end.

Close the fixture database and daemon, retain `pairing-v2-pending.json` with
`passed` and `resourcesClosed`, require wrapper exit 0 and remove temporary
data. The iOS scanner and the comparison digits stay outside this proof.
