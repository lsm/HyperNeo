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
to represent the slow reads observed during the live deploy. Daemon availability
must take under one second, independently of that history validation; all five
markers must reach the model. The latency is controlled fixture storage I/O,
not a claimed measurement of production hardware. No real database is copied.

Evidence is `$RUN/evidence/spent-admission-{idle-ordinary,idle-neo,history-neo}.json`,
including idle state, exactly one restart, startup time, queue lifecycle and model
receipts. The helper closes its daemon, SDK and model listener in finally.
