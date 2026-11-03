# Conversational peer pairing on two isolated daemons

Use the metadata-only wrapper and isolation rules in SKILL.md. Select the pinned
Bun runtime on PATH and a short temporary root for native Unix sockets:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-peer-pair.ts
```

The helper generates a disposable test certificate and starts two independent Bun
daemon processes, each with its own HOME/data/DB. Their HTTPS listeners use free
ports and normal TLS verification with only the generated certificate added to
the children's trust. No real accounts, credentials, model turns or GitHub calls
are used. The helper stops both daemons/listeners and waits for child exit; the wrapper preserves redacted
evidence and removes all temporary data and test key material.

Through the real Neo MCP server and the real HTTP pair route:

- Record a human request through neo.message.send, mark the synthetic delivery
  consumed, and invoke invite/accept/list/remove with the server's current input id.
- Pair both directions, retaining each local relationship id. Public results must
  contain no credential, and the stored invite must be hashed.
- A consumed external system input must not authorize friend management.
- Exactly one of two concurrent claims wins; replayed and expired invitations,
  extra request fields and oversized bodies are refused.
- A peer credential must not give access to owner data over the generic RPC door.
  Probe neo.snapshot through a new WebSocket, then repeat without a credential;
  both handshakes and owner reads must be refused. Only the local proof client
  authenticates with its isolated owner file; pairing never adds a device.
- Remove the relationship and verify the incoming credential hash and outgoing
  secret are gone, without adding a paired device.

The proof fails if generic owner RPC remains reachable by the peer/anonymous
client. Retain ownerRpcBoundary in neo-peer-pair.json and resolve that boundary
before claiming isolation. A partial run is not a pass. This proves transport,
recorded-human admission and secret storage, not natural-language interpretation
or peer message delivery; those belong to PR2 and the human's post-deploy setup.
