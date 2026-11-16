### Model-routing tells Neo once about a long hold

```bash
RUN=$(mktemp -d /private/tmp/hn-line-held-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/model-routing-line-held.ts "$RUN"
```

An isolated real daemon gets one Neo session and an ask with two `doing` todos. Each todo is
bound to a HyperNeo worker session held by a usage limit (`rate_limit_cooldown`, reason
`limit`): one has been held for 31 minutes, the other for 10. The real pack sweep runs:
- with `model-routing` off, Neo gets nothing;
- with it on, two sweeps queue exactly one mailbox wake for Neo, about the 31-minute hold. A
  fresh daemon has no route, so the notice says no other line is listed.

`evidence/result.json` keeps the wakes and the commit. Only synthetic data and a temp HOME
are used, and no provider key may be set. The route-lines text and the `onHold`
rules are covered by the unit tests.
