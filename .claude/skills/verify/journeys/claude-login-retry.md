# A rejected Claude login holds the turn until the login is saved

Use **In-process RPC proofs** in ../SKILL.md. Preflight ports 8000/8001.
Build packages/web first. Run each case with a different fresh RUN/home:

```sh
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_USE_DEV_PROXY=1 \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/claude-login-retry.ts "$RUN" recover
```

The helper owns its daemon, local HTTP proxy and mock model. It disables external
MCP entries and stores only the synthetic dev-proxy provider key in its fresh DB.
No auth file, real credential, live daemon/DB or port 8399 is accessed. SDK spawn
instrumentation records PIDs only; no environment values or headers are recorded.
All resources close in finally, including the optional web server.

The fake endpoint rejects the first SDK process with 401 authentication_error /
OAuth token revoked. The turn is not charged to the failure episode and does not
latch "stopped": the daemon runs the login path, records `needs_login_at` on the
provider, and holds the turn in `rate_limit_cooldown` with `reason: 'login'`.
An API-key provider cannot refresh, so the hold asks for sign-in instead of
restarting. `recover` then writes a credential over RPC (`providers.update` with
an apiKey) and asserts the write clears `needs_login_at`, wakes the hold, starts
the second SDK process and lets the original prompt finish with a successful
result. `observed.json` records requests, response statuses, PIDs, the hold, the
sign-in flag and synthetic SDK messages. Credentials and file contents are never
inspected.

`fail` stops before the credential write: after the 401 the same hold must
appear, no second subprocess may start, and no terminal notice may be emitted.

Before this behavior, one SDK process repeatedly received 401 and the query was
charged until the third failure latched the episode and cleared the queue.

`--serve` additionally serves the production build on an ephemeral port. In
headless Playwright import `claude-login-web.mjs` and call
`verifyClaudeLogin(page, run)`. Without `--historical-result` it checks that the
login hold does not read as a failed login on /neo and /session at 1280 and 390,
with no horizontal overflow. The bottom banner still reads "Rate limit reached"
until the model-hold line lands; the helper asserts the banner, not the wording.
Inspect all screenshots independently. The helper writes browser.json and
browser-done, allowing daemon/mock/server cleanup.

## Historical result text regression

Add `--historical-result` with `--serve` to save one synthetic historical SDK
payload with subtype success and is_error true in this run’s DB. It is separate
from the real HTTP failure above. The browser helper then requires the
`Rate limit reached.` hold banner with no `Claude login failed — sign in again`
notice on the Neo page and the session page, opens
Result details and requires its synthetic GLM rejection text in the red Errors
section at both widths; inspect session-result-error-1280/390.png. The GLM query
contract also registers a synthetic available GLM provider, makes SDK option
construction reject with 401, and checks one attempt with the provider API error
notice rather than a Claude login retry or remediation. No GLM or Claude
credential is used.
