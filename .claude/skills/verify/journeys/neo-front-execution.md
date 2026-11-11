# Convo execution

Run `neo-front-execution.ts` through `proof-run.sh` with pinned Bun. Set
VERIFY_CLAUDE to the pinned native CLI when checking a specific CLI version.
The helper owns a disposable HOME, DB and loopback model fixture on random ports.
It uses the real SDK through the ordinary session runtime.

Enable dual-model mode and send a human message through the authenticated Neo
operation. Require the daemon to present Convo's tool-free terminal answer with
the original replyTo. Send a second input that Convo hands to Neo through run_in_background.
Require direct Neo publications to be refused in dual-model mode. Neo sends its
result internally and Convo publishes it. Send a later result for the same input
and require another Convo publication to succeed. An acknowledgment leaves the
answer outcome pending.
Switch to single-model mode and preserve the same Convo SDK session identity.

Retain neo-front-execution.json with passed and resourcesClosed true and wrapper
exit 0. The helper closes the daemon, SDK queries, provider bridges and HTTP
fixture. This proves transport and tool behavior with scripted API responses.
