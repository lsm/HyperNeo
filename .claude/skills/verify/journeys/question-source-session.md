# A worker-derived question opens its source session

Use the shared metadata-only isolation setup: fresh HOME/data/workspace/database,
`NODE_ENV=test`, no credentials or model. Build web first. Pick a free port,
never 8399. The seed creates only synthetic root/worker sessions and an ask.

```bash
mkdir -p "$RUN/home" "$RUN/evidence"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/question-source-session.ts "$RUN" seed
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun packages/cli/main.ts --port 9482 --db-path "$RUN/data/daemon.db"
```

Keep the daemon in an owned shell/EXIT trap; wait for its HTTP listener. Run
`question-source-session.ts "$RUN" capture 9482` with that same clean environment.
It invokes the real question API with `sourceSession:{adapter,id,daemon?}` and
checks `neo.question.get` and `neo.snapshot` retain the adapter-resolved source.
The helper also rewords a start question with a source, then adds another instructed
todo through `neo.todo.add`; the mechanical join must preserve the captured source.
An absent source stays absent; an unavailable source cannot replace the card.

With headless Playwright available through NODE_PATH, run:

```bash
NODE_PATH=<directory containing playwright> VERIFY_BROWSER=<Chromium executable> \
  node .claude/skills/verify/question-source-session-web.mjs 9482 "$RUN"
```

At 1440px and 390px, the source question shows its name and provider at top-right,
and the start question keeps its working opener after the todo join. Open session enters the existing HyperNeo session pane. Back retains the
answer buttons. The general question has no session opener. The mobile check
answers yes and reads back both the answer and unchanged source ref. Screenshots
and receipts stay in `$RUN/evidence/`. No native app is opened: the Codex opener
callback is covered by the component contract, not a real Desktop acceptance test.

Stop and wait for only that test daemon, restart it against the same synthetic DB,
then run the helper with `restart`. Its answered question and open joined start question must still retain the
source, including the ref used by the separate iOS follow-up: `question.sourceSession`
contains `adapter`, `id`, optional `daemon`, plus captured `name`, `provider`,
`label` and `link`. No source is inferred from prose or multiple workers. Stop the
daemon again after this persistence check. The worker identity is captured when
Neo asks the question; this journey does not claim live rename tracking.
