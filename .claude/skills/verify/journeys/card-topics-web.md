# Neo cards show their topic in the Inbox

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

- `card-topics.json` has `passed: true`. Each card displays a topic tag with a colored
  border and its state below the title. The untopiced card shows 其他 and the
  two generic project badges show 项目.
- The topic labels are read-only when the queue is available, including in search
  results. The standalone topic chips are absent. At 390 px the state row fits
  without sideways page scrolling.
- Inspect the desktop and mobile captures in both themes.
