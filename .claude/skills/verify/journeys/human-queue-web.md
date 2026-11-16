# The web inbox lists what waits on the human, with hold and take back

Build the web bundle (`cd packages/web && bun run build`). Seed a fresh synthetic run,
launch per SKILL.md on a free port (never 8399), then drive headless Chromium:

```bash
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/human-queue-web-seed.ts "$RUN"
.claude/skills/verify/launch.sh <port> "$RUN"
HYPERNEO_DATA_DIR="$RUN/data" NODE_PATH=<playwright> node .claude/skills/verify/human-queue-web.mjs <port> "$RUN"
```

The seed opens two synthetic asks with three open yes/no cards (one about the whole
ask) and one todo that waits on another. No key or model is used.

End state, in `$RUN/evidence/`:

- `human-queue-web.json` has `passed: true`. The state row reads
  `Waiting on you 3`, `Held 0`, `In progress 1`; the ask row reads `All 3` and one
  chip per ask.
- Hold on a card moves it to Held through `neo.question.hold`; Take back returns it.
- In progress lists the waiting todo with whose step it is.
- At 390 px the inbox stays inside the screen and the ask row stays on one line.
- `inbox-1280-{light,dark}.png`, `inbox-1280-held.png` and `inbox-390-{light,dark}.png`.
