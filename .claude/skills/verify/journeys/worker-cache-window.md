# Release kept workers whose prompt cache went cold

Use the shared isolation and resource-check setup in `../SKILL.md`:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/worker-cache-window.ts
```

The helper starts an isolated daemon with a synthetic home and database, sets
`sessionReuse` to `per_ask`, and starts two HyperNeo workers through the real
`work.start` operation, each for its own open ask. It stores one main-thread
assistant turn per worker, two hours old for `cold` and one minute old for `warm`,
finishes both todos, and runs the real Neo driver refresh job. It requires the cold
worker to be archived with a `released` fact and the warm worker to stay active with
`release_kept`. The wrapper saves `worker-cache-window.json` and removes the
temporary daemon data. No model turn runs, so this does not exercise a provider's
real cache usage, the one-hour Claude cache, or Codex workers.
