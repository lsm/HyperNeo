# Neo explicitly answers or asks back about received human messages

Run from the worktree root with a fresh absolute run directory:

```bash
bash .claude/skills/verify/neo-explicit-replies.sh /tmp/hyperneo-explicit-replies-fresh
```

Shared isolation stays in SKILL.md: NODE_ENV=test, fresh HOME/data/DB,
synthetic DB-stored credentials, a GitHub stub, and loopback model/daemon ports.
No real provider, credential file, live database or port 8399 is used.

The installed SDK receives the intake-stored human message id and invokes
`neo.publication.publish` with `replyTo: [id]`, retries it idempotently, and
invokes `neo.question.ask` citing the same id. A real scheduled-note delivery also
appears through neo.conversation.read using explicit scheduler metadata; it
creates no origin stamp. The actual web publication reader
preserves the reference, and `neo.question.get` returns the stored question's
reference. A publication answers only the human inputs it names; a question
asks back without marking its inputs answered. Omitting replyTo stays supported.

The operations contracts cover several received messages, selecting only the
first and third as answered; unknown, foreign, system, task and queued input
ids; mixed valid/invalid lists; durable question reads and start-question
rewording. Publications omit unrecognized references and retain valid received
human ids; question admission is covered by its own journey.
New publications refuse triggerId; old stored triggerId/askOrigin remain readable.

Evidence: `sdk/evidence/neo-goal-cycle-sdk.json` contains actual model input,
MCP tool receipts, stored publication/question and the web reader result.
`evidence/unit.log` and `sdk/evidence/web.log` contain operation and reader
contracts. Resources close in finally. This proves the RPC/MCP and web-reader
surfaces; no GUI rendering or production restart is claimed.
