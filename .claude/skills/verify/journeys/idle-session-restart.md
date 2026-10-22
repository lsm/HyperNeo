## Idle inputs drain after one restart

Run `bash .claude/skills/verify/idle-session-restart.sh "$RUN"` with a fresh absolute
run directory. Follow SKILL.md isolation: fresh HOME/data/DB, NODE_ENV=test,
synthetic loopback model credential and ephemeral ports, never 8399. The helper
uses the installed SDK and actual WebSocket RPC; it disables external registry
MCP servers through RPC so internet-dependent tools cannot block SDK startup.

Neo and an ordinary session consume kickoff and become idle. The fixture queues
five new inputs in its own DB, restarts the daemon exactly once, and requires
all markers in actual model requests and consumed rows without another send.
This differs from the earlier interrupted-turn/replayed-input journey.

The large-history case seeds 30,000 synthetic archived result rows with complete
side bodies and the copy-complete marker. It injects 50 ms per coverage page read
to represent the slow reads observed during the live deploy. The real coverage
worker is held pending: all five markers must reach the model and become consumed
before coverage is released, then the real worker must finish successfully.
Startup time is recorded as a diagnostic, without a machine-speed cutoff.
The latency is controlled fixture storage I/O,
not a claimed measurement of production hardware. No real database is copied.

Evidence is `$RUN/evidence/spent-admission-{idle-ordinary,idle-neo,history-neo}.json`,
including idle state, exactly one restart, startup time, queue lifecycle and model
receipts. The helper closes its daemon, SDK and model listener in finally.

The initial regression commit `159af8980` fails the large-history availability
assertion at 2,267 ms; the five markers eventually reach the model, exposing a
startup gate rather than a lost delivery wake. The first fixed run binds in
361 ms and drains all markers. The final run also requires successful completion
of the real read-only worker, so worker-unavailable fallback cannot pass it.

The ordering assertion replaces the original one-second availability cutoff after
CI completed delivery/verification but exceeded that wall-clock limit. Holding
verification pending proves it cannot gate a usable daemon, independent of CPU
speed; it retains the same one-restart and complete model-receipt requirements.
