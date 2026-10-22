# Explicit attribution without inherited origin stamps

Run from the worktree root with a fresh absolute run directory:

```bash
bash .claude/skills/verify/neo-no-implicit-attribution.sh /tmp/hyperneo-no-implicit-attribution-fresh
```

Shared isolation stays in SKILL.md: NODE_ENV=test, fresh HOME/data/DB, synthetic
DB-stored credentials, a GitHub stub, and owned loopback daemon/model ports.
No live daemon, provider, credential file or port 8399 is used. Helpers close
all resources in finally.

The installed SDK receives a scheduled note through ordinary mailbox delivery.
The RPC conversation reader shows its wake from explicit scheduler metadata.
The same SDK then publishes a human reply and asks a question using replyTo;
the web reader and question.get preserve the exact referenced human id. A
publication receipt carries no implicit answered object. No origin stamp is
written. Unknown, foreign, system, task and queued references remain refused.

The upgrade fixture starts with legacy publications and a settled wake. It
copies explicit wake metadata into scheduler-owned history and leaves EVERY
original attribution row unchanged, including human, continuation and malformed
rows. Already-recorded legacy continuation boundaries are copied only as
historical wake metadata, preserving unstamped saved summaries; new deliveries
create no such boundary. Repeating the upgrade keeps the same conversation content. The retired
table stays stored but has no runtime readers or writers. Legacy publication
askOrigin and SDK metadata remain readable; no new lineage is inferred.

The ordinary/Neo/large-history restart journey then delivers every queued model
marker after exactly one restart, with no extra send or restart. Unit contracts
also retain conversation scope, both pagination directions and bounded wake
lookup VM work. To repeat the larger 140,000-header RPC query check, use the
conversation-wake-lookup-query journey; it now seeds pending scheduler metadata.

Evidence: evidence/unit.log, sdk/evidence/neo-goal-cycle-sdk.json (actual model
input, MCP receipts, wake RPC history and web reader), and
restart/evidence/spent-admission-*.json. No GUI or live restart is claimed.
