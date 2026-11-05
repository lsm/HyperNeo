# A busy worker gets no todo send

Neo sends two todos to a HyperNeo worker that is mid-turn. Neither reaches the
worker: both wait in HyperNeo's queue. A notice still goes straight through. When
the turn ends the oldest goes, and the second waits for the next turn to end.

Read SKILL.md's shared isolation setup. This helper owns a real test daemon with
a fresh database and home. No provider, model, GUI or port 8399.

```bash
RUN=$(mktemp -d /private/tmp/hn-held-sends-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/held-todo-sends.ts "$RUN"
```

The worker's turn is simulated by setting its session's processing state. Evidence:
`$RUN/evidence/observed.json`.
