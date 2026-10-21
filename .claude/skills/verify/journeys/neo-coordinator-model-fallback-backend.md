## Neo coordinator model fallback (backend)

Run `bash .claude/skills/verify/neo-model-fallback.sh "$RUN"` with a fresh absolute
synthetic run directory. The real isolated daemon and actual SDK use ephemeral
loopback ports, never 8399. A local Anthropic-shaped fixture returns a usage-limit
billing error for the configured primary and accepts the next model. A second
case uses the real GLM provider with its discovery/probe HTTP client redirected
to the loopback fixture and a session-scoped loopback base URL; the SDK itself
sends the GLM request through that provider. No Z.ai endpoint is contacted. Synthetic
SDK credentials exist only inside this fixture process; no real provider or
credential discovery is used. GitHub stays stubbed. The SDK and daemon transcript
lookup share the same synthetic directory so recovery resumes the real history.

The human-only `neo.preferences.set` RPC must persist an ordered fallback list.
The original input must produce a visible `neo.publication.read` garden reply on
the fallback, whose actual API request carries its configured low effort (or
8,000-token thinking budget). Both Anthropic and GLM cases must carry this
fallback effort; GLM requests must use the separate `/glm/v1/messages` endpoint.
The fixture then restores the primary and submits
a second human turn: that turn must complete on the primary with its configured
high effort (or 24,000-token thinking budget), demonstrating that
suppression lasts only through recovery. Evidence is retained even on failure in
`evidence/neo-model-fallback-{anthropic,glm}.json`; the helper closes the socket, SDK, daemon and
local model server in `finally`. On the pre-fix test commit, the first turn only
shows its usage-limit error and cannot complete the expected reply.

Focused contracts additionally cover ordered persistence, per-model thinking
clamping, unknown-model refusal, explicit empty chains and primary-only edits
preserving the chain. Existing general fallback selection remains in effect when
Neo's setting is absent. Retryable provider errors use the same watchdog only
for a configured Neo chain; ordinary sessions retain their provider retry policy.
OpenAI/Copilot and OpenRouter are accepted through the same catalog/provider
switching path but are not verified by these two fixture cases.
Web Settings editing is a separate follow-up to this backend slice; no GUI or
real provider outage/reset clock is verified here. The next-turn restored-primary
case is synthetic evidence of recovery, not a live account availability probe.
