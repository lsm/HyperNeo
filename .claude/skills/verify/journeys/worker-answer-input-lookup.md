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

A synthetic Claude Desktop record maps local_card to the CLI transcript's UUID.
Reading that Desktop owner must find answers in actual claudeInboxFrame wrappers,
peer-origin meta inputs and queued peer attachments. The synthetic inbox frame
explicitly declares `fromMode: 'prompting'` as required by the current protocol; the raw CLI ID must not
impersonate its Desktop owner. The same inputs remain readable as Claude Code
work on that exact CLI session. The helper also starts one synthetic
pinned Copilot SDK peer and adds past/future-dated inputs followed by 160 later
entries exceeding its 256-KiB history page. Both exact markers must remain
readable after restart without resuming the peer; an unowned ID must not match.
Repeat an absent Copilot marker against unchanged history, then append that input
and observe it through RPC immediately. Unit I/O controls require no history
bytes on repeated misses and fresh reads after append, same-size rewrite,
replacement or adapter restart. A missing match always stays uncertain.
Native records larger than the bounded history page remain unreadable and must
stay uncertain; incomplete scans are never memoized, and older readable inputs
must remain discoverable across such a record. The helper injects one oversized
native event to exercise that limit. Worker-card sends use work.send's existing
20,000-character body limit; this journey does not claim general oversized-event
reconstruction or acceptance from missing evidence.
Completeness applies to the entire cursor walk. A window that skips the end of
an oversized record is followed by an earlier window containing its unparsed
beginning; that window marks the scan incomplete. Unit layouts place the record
at EOF and before 80 later records, require repeated misses to read history,
and retain the zero-byte repeat check for complete ordinary histories. The RPC
journey uses the 80-record tail and finds older readable inputs after restart.

Keep receipts.json, observed.json, proof.log and cleanup.json. Both daemons stop
and their synthetic native files, HOME and DB data are removed after evidence is
saved. This proves the exact lookup foundation for #8874 across indexed native
inputs, Claude Desktop's owning-session alias and retained owned Copilot input.
Card reconciliation and hold release remain unverified by this journey.
