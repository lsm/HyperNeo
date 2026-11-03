# Accept a contact on two isolated daemons

Follow SKILL.md isolation and resource checks. Use pinned Bun on PATH:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-peer-receive.ts --accept
```

The shared helper owns two separate daemon processes and fresh homes/databases,
using ephemeral HTTPS endpoints with a generated certificate trusted only by the
children. No model or external network call is made.

- Record each human request over authenticated neo.message.send, invoke invite
  and accept through the actual Neo MCP tool, and list the resulting address.
- Accept the reverse invitation without changing the local contact id. Vault
  entries exist, but neither management receipts nor list disclose credentials.
- System input cannot authorize acceptance; a peer token and an anonymous client
  cannot open owner WebSocket RPC. No device is added by pairing.
- Replayed, expired, oversized and foreign-field claims are refused. Remove
  clears the local outgoing secret and incoming credential hash.
- Inject a synthetic vault deletion failure: MCP removal fails while list still
  contains the contact and vault entry; restore the vault and retry successfully.
  This models the failure without locking the human’s Keychain.
- Both daemon processes must exit cleanly before wrapper cleanup.

neo-peer-accept.test.ts additionally covers invalid origins, malformed/oversized
responses, and contact removal/name creation while the network claim is pending.
This proves the MCP/HTTPS management path; natural-language interpretation and
actual peer message delivery are not part of this slice.
