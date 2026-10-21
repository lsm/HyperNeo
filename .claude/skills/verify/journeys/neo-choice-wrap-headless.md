## Neo choice options wrap and carry letters (headless)

Build web (`cd packages/web && bun run build`). Then launch a fresh isolated
daemon with `launch.sh` on a free port other than 8399. In the same shell, run:

```bash
NODE_PATH=<directory containing playwright> node .claude/skills/verify/neo-choice-wrap.mjs 9393 "$RUN"
```

The helper opens Neo over RPC. In its own temporary DB it seeds one
single-choice question and one pick-any question, each with three long options:
Chinese, English, and an unbroken URL. It loads the built `/neo` page headlessly
at 1280 and 390 px. Each option must start with its letter A, B or C in order,
stay inside the question box, and have no horizontal overflow. The page must not
scroll sideways. It takes card screenshots before asserting, so a failing run
still shows the layout.

Evidence: `evidence/neo-choice-wrap.json` and `neo-choice-wrap-{1280,390}.png`.
Stop with `stop.sh`.
