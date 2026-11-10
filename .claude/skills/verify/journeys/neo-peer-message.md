# Send a peer message between two isolated daemons

Follow SKILL.md isolation and resource checks. With pinned Bun on PATH:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-peer-receive.ts --message
```

The shared helper owns two independent daemon processes/homes/DBs and ephemeral
HTTPS endpoints with a certificate trusted only by the synthetic children.
Record each side’s consent, invoke pairing and send through the real Neo MCP tool.
The receiving mailbox must contain one system input from its locally named
contact, quoted as external data, with no human ask or approval created. Replay
the same request before and after simulated consumption: no second message.
A scripted Neo consumes that exact system envelope and publishes a named
explanation; read it through the real public publication reader. This is scripted
Neo behavior, not a claim about real-model reasoning or natural-language intent.
The consumed peer system input cannot authorize sending or contact management.
Foreign fields cannot target sessions or approvals. After receiver removal,
new delivery is refused. Existing pairing, vault-failure and owner-RPC boundary
assertions still run. Both children must exit cleanly before wrapper cleanup.
