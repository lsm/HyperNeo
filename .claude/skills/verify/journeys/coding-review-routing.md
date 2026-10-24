# Coding review routing API (#8440)

Read shared SKILL.md first. This Build slice exposes `createCodingPack(...).review`
for actor assignment (#8428) and gates (#8429). No public dispatch or ingestion
is wired here. The helper runs the real pack API with an isolated SQLite database
and a durable synthetic assignment effect; it opens no reviewer/model sessions,
contacts no GitHub, and needs no provider, daemon, browser or reserved port.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-review-routing-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/coding-review-routing.ts "$RUN"
cat "$RUN/evidence/routing.json"
cat "$RUN/evidence/assignments.json"
```

Observe exact-head bot approval, retained approval after COMMENTED/PENDING
reviews, invalidation after a push and no reviewer assignment while waiting. With no configured bot, observe exactly one persisted
synthetic assignment and its returned ID. Retain both files. Review inputs must
use the repository's configured bot, the latest observed PR head and reviews in
chronological order, as the existing GitHub ledger reader supplies them.

This is runtime API evidence, not proof of user-facing actor dispatch. Full
public dispatch, preference resolution and live-head merge enforcement remain
unverified until #8428/#8429 wire this API; extend those journeys when they land.
