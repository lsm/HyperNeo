# Recovered Neo inputs use fresh SDK attempt identities (#8068)

Follow SKILL.md isolation and run `spent-admission-restart.sh "$RUN"` with a fresh
absolute run directory. Use the release-pinned Bun 1.4.2 first on PATH. The helper
owns loopback model and daemon listeners, fresh HOME/data/DB, a GitHub stub and
synthetic DB-only provider credentials. It uses the installed Claude Agent SDK,
not the unit SDK mock. No real keys, daemon/DB, GUI or port 8399 are involved.

Neo receives an initial human message, a held turn, mid-turn steering, then a
restart with the original durable input recovered and four queued markers.
Every marker must reach the model and every durable row must be consumed.
The child SDK stdin trace must contain no recovery UUID already sent before
restart. The original durable input ID must still identify the consumed row.
The ordinary-session control retains its existing delivery behavior.

Evidence: `$RUN/evidence/spent-admission-neo.json` includes transportInputs,
model receipts, durable states and freshRecoveryIdentities. Before the fix the
actual SDK trace repeats the original transport UUID across restart. After the
fix each Neo delivery has a fresh transport UUID while incoming SDK attribution
maps back to the durable input ID. Daemon, SDK and model resources close in
finally; retain synthetic evidence. No real-provider behavior is claimed.
