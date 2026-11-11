# Pairing v2 recovery on the DB worker

Run `pairing-v2-recovery.ts` through `proof-run.sh` with pinned Bun and the checkout
head. It owns a fresh test HOME, database, daemon and random loopback port. It
uses synthetic Ed25519 keys and never saves tickets, device credentials or cookies.
Set `TMPDIR=/tmp` on Linux before invoking the wrapper:

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/pairing-v2-recovery.ts "$(git rev-parse HEAD)"
```

This slice exposes registered DB operations, not the future `/pair2` HTTP route.
Drive create, bind, approve, complete and status through the real DB gateway.
Force the isolated daemon main connection into query-only mode and reject pairing
SQL there; the registered operations must continue through native DB workers.
A completed human grant must close recovery, remove peer human-code approvals,
end recovery-based terminal approval, and authenticate an actual WebSocket.

Reject device insertion inside a second grant. The request must remain approved,
recovery must remain open, no extra device may exist, and the prior peer approval
must still redeem. Require zero target main SQL attempts. Close the socket, DB
workers and daemon, retain `pairing-v2-recovery.json` and wrapper exit status,
and remove temporary data. Phone UI and `/pair2` routing are outside this proof.
