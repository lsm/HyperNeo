# GitHub polling uses the authenticated bucket

Read shared setup in `../SKILL.md`. This helper owns its isolated daemon and a
loopback GitHub fixture; no model or GUI is needed. It never uses the real gh,
GitHub, keys, auth files, Keychain or port 8399. Start with a fresh RUN for each
scenario from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-github-bucket-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=info \
  bun .claude/skills/verify/github-poll-auth-bucket.ts verify private 9363 "$RUN"
```

Repeat with `exhausted`, then `secondary`, using new run directories and free
ports. The fake executable named gh only forwards structured API requests to
its own loopback fixture. It refuses credential extraction and other commands.
The daemon has no token in its environment or synthetic credential store.

The fixture seeds three previously polled public repos and seven never-polled
private repos. It provides two distinct accounts/buckets: direct anonymous
requests see private HTTP 404 or an exhausted 60-request/core bucket; the fake
authenticated CLI has 5,000 core requests and can read all ten repos. Calls enter
through actual public `/ws` `space.github.pollOnce` twice.

Observe `evidence/auth-bucket.json`:

- `private` and `exhausted` both produce recent lastPollAt for all ten repos on
  both polls, ten stored approvals and actual owner mailbox work. No anonymous
  request occurs. Model consumption is not verified; its processor is paused.
- `secondary` first returns an authenticated 403 with Retry-After 2 seconds,
  remaining 4,900 and an hourly reset far away. RPC reports rate-limited with a
  near retryAt; after the helper waits 2.1 seconds, all ten repos are polled.
  The hourly reset must not replace the explicit secondary delay.
- Public `space.github.getTokenStatus` reports configured/source `gh` and the
  synthetic login without returning a token. This supports the existing
  self-echo classification; a failed configured credential-store read never
  falls through to another account.
- Logs contain `GitHub polling credential bucket` with only repo, source name,
  HTTP status, resource, limit and remaining. A real deployment's old log lacked
  limit/resource/source, so it cannot retroactively prove anonymous attribution.
- One synthetic ledger GraphQL read exercises `PR ledger GitHub read` logging:
  resource graphql, fixture cost 7, remaining 4,866, reset and elapsed time. This
  validates telemetry, not actual live request volume or attribution.

At the failing reproduction commit, `reproduce private` keeps all seven private
repos NULL despite the fake CLI login. `reproduce exhausted` sets an anonymous
hour-long cooldown and the second RPC skips without reaching them. Preserve the
before JSON. Unit regressions additionally show a generic GraphQL refusal with
healthy hourly remaining must not inherit its hour-long reset; true exhaustion
still uses that reset, and explicit Retry-After headers remain authoritative.

The earlier fairness journey uses the same loopback CLI transport now, preserving
its 201-PR, 40-request and stage-4/5/6 resume fixtures. Neither journey claims
that authenticated core and GraphQL quotas are interchangeable. The existing
ledger sweep is once per five minutes and sequential per repo; its new cost
logs, rather than the schedule alone, are needed to measure actual volume.

Settings connection-card regression: the authenticated gh CLI source must be
labelled, Disconnect disabled (it cannot clear an external login), and saving
a keychain override must ask before shadowing that login. Run the retained
`SpaceExternalEventsSettings.test.tsx` contracts for env and gh sources. For a
manual isolated web check, build packages/web, then run
`bash .claude/skills/verify/github-poll-cli-ui.sh "$RUN" 9364` with a fresh
absolute RUN. Open the created space Configure > Events in the browser, observe
those controls, then decline the replacement
confirmation and check that no token-write RPC ran. Never use a real login for
this check. Create `$RUN/stop` to stop its daemon when finished. Component results alone do not establish a browser interaction pass.

The helper closes its WebSocket, daemon and loopback server in finally. Stop any
remaining owned process on failure and retain evidence. After a real deployment,
first read `hyperneo build` and prove it contains the merge, then inspect only
read-only watched-repo timestamps, concerns and existing event/delivery metadata.
Never create a live event to make the delivery check pass. Report unknowns and
keep this fairness check separate from later single-source API-count reduction.
