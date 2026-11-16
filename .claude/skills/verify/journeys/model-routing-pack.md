### Model-routing pack ranks lines

```bash
RUN=$(mktemp -d /private/tmp/hn-model-routing-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/model-routing-pack.ts 9353 "$RUN"
```

An isolated real daemon enables `model-routing` through the `settings.global.update`
door. Its `routes` and `rules` go through `pack.preferences.set`: an out-of-range
`stopAtPercent` is refused, valid lists are saved and read back. The pack then ranks lines
in that daemon's process, against its database and real provider registry. Lines come
back in the saved route order. A provider that is not installed, and Anthropic (a fresh daemon
enables no provider), are both skipped as `not configured`, so the ranking is exhausted.

`evidence/observed.json` keeps every response and the rankings. Only synthetic data and a
temp HOME are used, and no provider key may be set. Because nothing is signed in, this
does not show holds or usage on a real provider. The unit tests cover those cases.
Nothing calls `chooseLine` yet, so no todo start is involved.
