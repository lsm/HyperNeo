# Exact input lookup on the owning native peer

Use SKILL.md's metadata-only wrapper with no model or fixed HTTP port:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/worker-answer-input-lookup.ts
```

The helper owns two isolated source daemons with separate HOME/data/DB directories
and ephemeral loopback listeners. It refuses gh, open and ps; no credentials,
native applications, provider turns or live daemon are involved. It ingests
synthetic Codex and Claude Code transcripts through the production native-feed
parsers into each daemon's retained index.

Through real work.read RPC, exact input identities must find user inputs dated
behind and ahead of the local clock despite 160 intervening inputs. An assistant
quotation, a partial marker, a missing marker, the same ID on another adapter,
and another worker must not count. A marker available only on the attached peer
must be found only through that named owning daemon. Restart the querying daemon
and confirm both old identities remain readable from its persisted history.

Keep receipts.json, observed.json, proof.log and cleanup.json. Both daemons stop
and their synthetic native files, HOME and DB data are removed after evidence is
saved. This builds the exact indexed Codex/Claude Code lookup for #8874; card
reconciliation, Claude Desktop's distinct session alias and Copilot history are
not verified by this journey. Those adapters must not be claimed supported by
this lookup until their owning-session mapping has its own proof.
