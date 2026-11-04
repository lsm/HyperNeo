# A daemon send has one named owner

A PR nudge is recorded in `work_delivery_inputs` under the open todo that holds
the PR, so its turn cannot land on whichever todo sent last. A Neo send with
neither a todo nor `notice: true` is refused unsent.

Read SKILL.md's shared isolation setup. This helper owns a real test daemon, a
fresh database and home, a `gh` that refuses every call, and a synthetic Codex
Desktop socket. No provider, model, real GitHub, GUI or port 8399.

```bash
RUN=$(mktemp -d /private/tmp/hn-send-owner-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/daemon-send-owner.ts "$RUN"
```

One worker holds two todos. `feature` holds the PR and `docs` sent last, which is
the shape that went wrong before. A ledger row seeded as waiting on requested changes makes the real sweep send a nudge.
Its row must name `feature`. A turn ending in `Blocked (needs_human)` must block
`feature` and leave `docs` and its report unchanged. Evidence:
`$RUN/evidence/observed.json`.
