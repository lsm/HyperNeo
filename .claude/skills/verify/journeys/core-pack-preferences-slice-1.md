### Core pack preferences (slice 1)

```bash
RUN=$(mktemp -d /private/tmp/hn-pack-preferences-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/pack-preferences.ts 9351 "$RUN"
```

The helper boots the real isolated daemon twice and reads `system.health` over
WebSocket on each boot. `evidence/observed.json` must show only the explicit empty Coding watch list
on first boot: merge/review preferences remain unanswered. The watch list is an
instance boundary rather than a review-policy default.
One synthetic human setting and its provenance/timestamp survive restart, and
an unanswered repo stays unanswered. The helper inserts only synthetic fixture
data directly; the human-only settings operation belongs to slice 2. It uses
only its fresh DB and temp HOME, without providers or credentials. Both instances
stop in `finally`. This proves bootstrap persistence and the core lookup; there
is no settings RPC/UI or merge-policy enforcement in slice 1. Those later slices
need their own journeys. No live DB, GitHub request or model turn is involved.
