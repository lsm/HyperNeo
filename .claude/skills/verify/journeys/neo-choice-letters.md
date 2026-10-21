### Neo choice letters

```bash
RUN=$(mktemp -d /private/tmp/hn-choice-letters-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/neo-choice-letters.ts 9391 "$RUN"
```

The helper starts a real isolated daemon with synthetic data only. Neo asks one
single and one pick-any choice question over MCP, each with long Chinese and
English options. `neo.snapshot` must carry `optionLabels: ['A','B','C']` on both.
The human replies `B吧` and `选A、C` through `neo.message.send` over RPC. The
answers must be stored as those options with `answeredBy: chat`, and Neo's prompt
fact must read `with B (<option>)`. Pass `hold` as a third argument to keep the
questions open and the daemon up for screenshots. Evidence:
`evidence/neo-choice-letters.json`.
