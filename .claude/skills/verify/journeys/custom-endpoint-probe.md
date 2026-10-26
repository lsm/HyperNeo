# Custom endpoint Test connection uses the daemon

Use the metadata-only isolation rules in SKILL.md. Build the worktree's web UI,
then run `node .claude/skills/verify/custom-endpoint-probe.mjs "$RUN"` with a fresh
absolute `/private/tmp/` directory that does not exist yet. Set NODE_PATH to a
directory containing Playwright, VERIFY_BROWSER to a Chromium executable if
needed, and VERIFY_BUN to the pinned Bun executable. The helper owns its fresh
test HOME/data/DB, ephemeral non-8399 ports, headless browser profile, daemon and
synthetic HTTP endpoint; it closes them in finally. No provider keys are inherited
and no real account, model turn or human app is used.

On the actual built Providers page, edit unsaved OpenAI and Anthropic URLs ending
in their inference paths. Fetch models succeeds against a fixture with no CORS
headers. Editor Test connection must also succeed, with exactly the same normalized
URL and headers as discovery, including Anthropic x-api-key/version and header
overrides. Endpoint requests must have no browser Origin. After discovery warms
its cache, the fixture switches to HTTP 503: a second Test must display that failure,
proving it actually probes instead of reusing cached discovery. No endpoint is saved
with the edited values.

Keep `evidence/result.json`, both screenshots and daemon.log. Before the fix, this
same helper fails with browser CORS errors and only discovery reaches the endpoint.
After the fix both protocols pass through the daemon. This verifies the editor
probe, not real provider credentials or inference.
