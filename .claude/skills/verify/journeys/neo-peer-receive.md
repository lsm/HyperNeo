# Incoming contact consent on two isolated daemons

Follow SKILL.md isolation and resource checks. Use the pinned Bun on PATH:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-peer-receive.ts
```

The helper starts two independent daemon processes, homes and databases, with
ephemeral HTTPS listeners and a generated test certificate trusted only by the
children. No model or external network calls are made. Both processes must exit
cleanly before the wrapper removes their homes, data and certificate material.

- Record a human request through authenticated neo.message.send, then invoke
  invite/list/remove through the real Neo MCP server with its consumed input id.
- Claim invitations from the other test process over HTTPS; the owner-only
  credential is used only by each daemon's local proof client.
- Invitation text is absent from stored rows. Replays, expired invitations,
  extra fields and oversized bodies are refused; concurrent claims win once.
- Peer and anonymous WebSockets cannot open or read neo.snapshot. Pairing adds
  no device. Removing a contact removes its incoming credential hash.
- A consumed external system input cannot authorize invite or remove.

neo-peer-receive.test.ts also advances time between admission and queued writer
execution: the claim must use its fresh execution time and reject expiration.
The API catalog must contain invite/list/remove. For outgoing acceptance and vault
storage, follow neo-peer-accept.md. This journey does not claim natural-language
interpretation or actual peer message delivery.
