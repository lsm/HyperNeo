## Neo cards show their topic, and the list filters by it (card topics PR 2)

Build the web bundle (`cd packages/web && bun run build`). Seed a fresh synthetic run,
launch per SKILL.md on a free port (never 8399), then drive headless Chromium:

```bash
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/card-topics-seed.ts "$RUN"
.claude/skills/verify/launch.sh <port> "$RUN"
HYPERNEO_DATA_DIR="$RUN/data" NODE_PATH=<playwright> node .claude/skills/verify/card-topics-web.mjs <port> "$RUN"
```

The seed opens seven synthetic asks: two 家长控制, one each of OAP, Countersign, 邮件 and
其他, and one without a topic; states todo, doing, done and dropped. No key or model is used.

End state, in `$RUN/evidence/`:

- `card-topics.json` has `passed: true` and chips `全部 7`, `家长控制 2`, …, `其他 1` last.
- Cards show the topic with its color square at left, and a state dot and word at right,
  with no pill. The untopiced card shows no topic.
- Tapping a chip filters, the filter survives reload, and a second tap clears it. Tapping a
  card's topic filters the same way.
- `topics-1280-{light,dark}.png`, `topics-1280-filtered.png` and `topics-390-{light,dark}.png`:
  at 390 px the chip row stays inside the screen and scrolls sideways.
