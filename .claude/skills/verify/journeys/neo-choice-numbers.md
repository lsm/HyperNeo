### Neo choice numbers

```bash
RUN=$(mktemp -d /private/tmp/hn-choice-numbers-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/neo-choice-numbers.ts 9391 "$RUN"
```

The helper starts a real isolated daemon with synthetic data only. Neo asks a
single and a pick-any choice question over MCP with long Chinese and English
options, a hotel card with `details` and `recommended`, and a plain hotel card.
`neo.snapshot` must carry `optionLabels: ['1','2','3']`, and the hotel card its
details and recommended option while still unanswered. The human replies
`第二个吧`, `选1、3`, `选二` and `no one` through `neo.message.send` over RPC. The
first three must be stored as the numbered options with `answeredBy: chat`;
`no one` must stay the human's own words. A detail keyed by a text that is not
an option must return `option_unknown`. Pass `hold` as a third argument to keep
the questions open for screenshots. Evidence: `evidence/neo-choice-numbers.json`.
