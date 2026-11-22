# Topic merge

Read shared isolated setup in `../SKILL.md`. No model, provider, browser, real
worker, external HTTP or GitHub is required. The helper starts its own real
daemon on an ephemeral loopback port, with a fresh HOME and synthetic DB.

```bash
RUN=$(mktemp -d /private/tmp/hn-topic-merge-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/topic-merge.ts "$RUN"
```

Through the production MCP adapter as the bound Neo session, it opens asks
picked `Kids`, `kids`, `孩子` and `家`, and settles the `kids` one. It makes the
startup-scheduled nightly reorganize job due and runs one real job-processor
tick: that job completes, schedules the next run, and queues exactly one
mailbox turn to Neo listing `Kids 2, 孩子 1, 家 1` and naming
`neo.topic.merge`. An unbound Neo session's `neo.topic.merge` is refused and
changes nothing. The bound session's `neo.topic.merge {from: "kids", to: "孩子"}`
answers `merged: 2` and rewrites both the open and the settled ask; `家` stays.
Evidence is `$RUN/evidence/topic-merge.json`.

A rejected 13-cell destination leaves the matched asks unchanged. Merge a
synthetic over-width legacy pick through `HyperNeo`, `neo-ios`, `支付` and a
12-cell pick made of five CJK characters and a family emoji. Merge from that
12-cell pick to `家庭` and check the stored result.
