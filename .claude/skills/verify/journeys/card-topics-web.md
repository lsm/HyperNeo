## Neo cards show their topic, and the list filters by it (card topics PR 2)

Build the web bundle (`cd packages/web && bun run build`). Seed a fresh synthetic run,
launch per SKILL.md on a free port (never 8399), then drive headless Chromium:

```bash
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/card-topics-seed.ts "$RUN"
.claude/skills/verify/launch.sh <port> "$RUN"
HYPERNEO_DATA_DIR="$RUN/data" NODE_PATH=<playwright> node .claude/skills/verify/card-topics-web.mjs <port> "$RUN"
```

The seed opens eleven synthetic asks: two 家长控制, one each of OAP, Countersign, 邮件 and
其他, one without a topic, picks `kids` and `Kids`, and one done ask in each of two projects
both titled `Shop` (each linked through its todo's worker session). States are todo, doing,
done and dropped. No key or model is used.

End state, in `$RUN/evidence/`:

- `card-topics.json` has `passed: true` and chips `全部 11`, `家长控制 2`, one `kids 2`,
  two `Shop 1`, and `其他 2` last.
- Each card shows its topic as a tag with a colored border right after the title, and the
  state word first on the line below. The untopiced card shows 其他.
- Each `Shop` chip shows only its own project's card; the `kids` chip shows both picks and
  survives reload; a card's topic button selects the same set as its chip.
- Tapping a chip filters, the filter survives reload, and a second tap clears it. Tapping a
  card's topic filters the same way, and during a work search it clears the search first.
- `topics-1280-{light,dark}.png`, `topics-1280-kids.png`, `topics-1280-filtered.png` and `topics-390-{light,dark}.png`:
  at 390 px the chip row stays inside the screen and scrolls sideways.
