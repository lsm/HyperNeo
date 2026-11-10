# Every worker send uses one path

A HyperNeo worker holding two todos gets a question answer. The answer goes
through `work.send`, is recorded under its todo, and the worker's turn reaches
that todo only. Neo's `message.send` stays inside its own project, and a repeated
idempotency key reaches the mailbox once.

Read SKILL.md's shared isolation setup. This helper owns a real test daemon with
a fresh database and home. No provider, model, GUI or port 8399.

```bash
RUN=$(mktemp -d /private/tmp/hn-send-path-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/send-one-path.ts "$RUN"
```

`other` sent last, which is the shape that went wrong before. A seeded result
ending in `Blocked (needs_human)` must block `answered` and leave `other` and its
report unchanged. Evidence: `$RUN/evidence/observed.json`.
