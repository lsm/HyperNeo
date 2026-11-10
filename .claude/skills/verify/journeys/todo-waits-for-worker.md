# A todo for a busy worker waits in the queue

Neo sends todos to a HyperNeo worker that is mid-turn. None reaches it: each stays
todo, unstarted, with a reason that says what it waits on. A wait past the stall step
tells Neo and the todo keeps waiting. When the worker frees up the higher priority
todo goes first, and the next one goes only after that one is done.

Read SKILL.md's shared isolation setup. This helper owns a real test daemon with
a fresh database and home. No provider, model, GUI or port 8399.

```bash
RUN=$(mktemp -d /private/tmp/hn-todo-waits-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/todo-waits-for-worker.ts "$RUN"
```

The worker's turn is simulated by setting its session's processing state, and the
stall by backdating the wait. Evidence: `$RUN/evidence/observed.json`.
