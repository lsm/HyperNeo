# Model list survives a cold SDK and a stalled provider

Use the shared resource guard and isolated in-process setup in ../SKILL.md with
PROOF=.claude/skills/verify/model-discovery-isolation.ts. No model API, provider
key, browser or real database is needed. The helper starts its own daemon on an
ephemeral non-8399 port and calls the actual models.list WebSocket door.

A synthetic provider answers at 15 seconds (matching the 15.2-second measured
first x64 SDK handshake under Rosetta); another provider never answers. Both
must start together. Forced refresh returns the answering provider's available
model, identifies the stalled provider as unavailable, and finishes within 35
seconds. The baseline errors at 10 seconds. Retain the full log and
model-discovery.json even on failure; the helper closes its daemon in finally.

Unit coverage separately exercises the actual AnthropicProvider SDK deadline,
partial forced refresh and concurrent stalled-provider isolation. The proof does
not replace fresh compiled CLI checks: after merge, rebuild both release
architectures and rerun release-candidate-fresh-install.md from the release PR.

For the authorized live performance comparison, use only the coordinator-approved
instance and port. Measure models.list (cached and forced) and count providers in
memory; never dump configuration or credentials. A loopback-only remote listener
may be measured through an existing authorized SSH connection. Do not change its
configuration, restart it, or contact any prohibited port. Record the before build
and timing; the after measurement is pending until the coordinator deploys the fix.
