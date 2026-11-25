# Ask topics

Read shared isolated setup in `../SKILL.md`. No model, provider, browser, real
worker, external HTTP or GitHub is required. The helper starts and stops its own
real daemon on an ephemeral loopback port, with a fresh HOME and synthetic DB.

```bash
RUN=$(mktemp -d /private/tmp/hn-ask-topics-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/ask-topics.ts "$RUN"
```

The fresh DB has the nullable `neo_asks.topic` column. Through the production
MCP adapter as a Neo session, `neo.ask.propose` with topic `" 家长控制 "` stores
`家长控制`, one without topic stores null, and a 13-character topic is refused.
`neo.ask.topic` sets `邮件` on the open ask; after the first ask is dropped it
answers `ask_settled: this ask is dropped.` and keeps its topic. The RPC
`neo.snapshot` shows both topics, again after a real daemon restart. Evidence is
`$RUN/evidence/ask-topics.json`.

Propose, edit and add a todo from a direct human input with `HyperNeo`,
`neo-ios`, `支付` and a 12-cell pick made of five CJK characters and a family
emoji. Each write rejects a 13-cell pick without changing the ask rows.
