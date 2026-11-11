# Front execution

Run `neo-front-execution.ts` through `proof-run.sh` with pinned Bun. Set
VERIFY_CLAUDE to the pinned native CLI when checking a specific CLI version.
The helper owns a disposable HOME, DB and loopback model fixture on random ports.
It uses the real SDK through the ordinary session runtime.

Enable dual-model mode and send a human message through the authenticated Neo
operation. Require Front to publish through its MCP publication tool with the
original replyTo. Plain assistant output must stay out of the publication page.
Refuse Back's direct publication, then send its result through message.send to
the same Front session. Require a second linked reply and an idempotent handoff.
Switch to single-model mode and require Back's publication to succeed while the
Front SDK session identity is preserved.

Retain neo-front-execution.json with passed and resourcesClosed true and wrapper
exit 0. The helper closes the daemon, SDK queries, provider bridges and HTTP
fixture. This proves transport and tool behavior with scripted API responses.
