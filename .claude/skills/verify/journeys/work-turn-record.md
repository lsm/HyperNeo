# Each finished worker turn is recorded

A HyperNeo worker finishes one turn with a PR URL in its output, then a shared turn
with two inputs that errors and mentions an older PR, and starts a third. The session
watcher records the two finished turns with their inputs, ending and URLs. The running
turn is recorded only after it ends. Any URL counts: core knows nothing about PRs.

Read SKILL.md's shared isolation setup. This helper owns a real test daemon with
a fresh database and home. No provider, model, GUI or port 8399.

```bash
RUN=$(mktemp -d /private/tmp/hn-work-turns-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/work-turn-record.ts "$RUN"
```

The worker's messages are synthetic rows. Evidence: `$RUN/evidence/observed.json`.
