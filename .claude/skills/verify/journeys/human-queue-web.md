# The web inbox lists what waits on the human, with held cards and take-back

Build the web bundle (`cd packages/web && bun run build`). Seed a fresh synthetic run,
launch per SKILL.md on a free port (never 8399), then drive headless Chromium:

```bash
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/human-queue-web-seed.ts "$RUN"
.claude/skills/verify/launch.sh <port> "$RUN"
HYPERNEO_DATA_DIR="$RUN/data" NODE_PATH=<playwright> node .claude/skills/verify/human-queue-web.mjs <port> "$RUN"
```

The seed opens three synthetic asks: a trip with a card on one todo, a held card about
the whole ask and one uncovered todo; a tax filing with a card on its todo; a car service
with one uncovered todo. The held card is written before the trip's todos exist, so it
stays about the whole ask. No key or model is used.

End state, in `$RUN/evidence/`:

- `human-queue-web.json` has `passed: true`, states `Waiting on you 2`, `Held 1`,
  `In progress 2`, and the asks row starting `All 2`. The old attention and running groups
  are gone, so the queue is the only list of open work.
- Hold on a waiting card moves it to Held through `neo.question.hold`, where held cards read
  "On hold"; Take back returns it,
  and the counts survive reload. In progress lists each uncovered todo with whose step it
  is, and choosing an ask narrows the list and the state counts.
- `queue-{1280,390}-{light,dark}.png`, `queue-1280-held.png` and
  `queue-{1280,390}-progress-{light,dark}.png` (In progress, with whose step each item is):
  at 390 px the filter rows wrap and the page does not scroll sideways.
