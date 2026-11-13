## Neo choice options wrap and show as written (headless)

Build web (`cd packages/web && bun run build`). Then launch a fresh isolated
daemon with `launch.sh` on a free port other than 8399. In the same shell, run:

```bash
NODE_PATH=<directory containing playwright> node .claude/skills/verify/neo-choice-wrap.mjs 9393 "$RUN"
```

The helper opens Neo over RPC and pairs a headless browser. In its own temporary
DB it seeds one single-choice question and one pick-any question, each with three
long options: Chinese, English, and an unbroken URL. A third single-choice
question has options that already carry Neo's letters (`A 先只改服务器`, ...).
It loads the built `/neo` page at 1280 and 390 px, in light and dark. Each
option must read exactly as written, with no letter drawn before it, so the third
card never shows `A A ...`. Each option must stay inside the question box with
no horizontal overflow, and the page must not scroll sideways. It takes card
screenshots before asserting, so a failing run still shows the layout.

Evidence: `evidence/neo-choice-wrap.json` and
`neo-choice-wrap-{1280,390}-{light,dark}.png`.
Stop with `stop.sh`.
