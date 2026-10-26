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

A synthetic Claude Desktop record maps local_card to the CLI transcript's worker
ID. Reading that Desktop owner must find the indexed Claude input, while using
the raw CLI ID as a Desktop owner must fail. The helper also starts one synthetic
pinned Copilot SDK peer and adds past/future-dated inputs followed by 160 later
entries exceeding its 256-KiB history page. Both exact markers must remain
readable after restart without resuming the peer; an unowned ID must not match.

Keep receipts.json, observed.json, proof.log and cleanup.json. Both daemons stop
and their synthetic native files, HOME and DB data are removed after evidence is
saved. This proves the exact lookup foundation for #8874 across indexed native
inputs, Claude Desktop's owning-session alias and retained owned Copilot input.
Card reconciliation and hold release remain unverified by this journey.
