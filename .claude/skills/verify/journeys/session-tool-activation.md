# Apply a saved tool choice without interrupting (Tools 6d.6)

Use shared setup in `../SKILL.md`. This metadata-only proof owns an isolated
daemon, synthetic DB/provider record, scripted SDK and a real in-memory MCP
client/server exposing `navigate`. No fixed ports, external command execution,
real provider, credential files or browser are needed.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/session-tool-activation.ts
```

Create a titled manual session so title generation is not counted as another
query. Its initial frozen choices leave the synthetic MCP server and instruction
guide off. Invoke the actual authorized `session.tools.setChoice` operation over
WebSocket with `{sessionId, key: 'mcp:<id>' | 'skill:<id>', selected}`.

Pass requires the public operation to persist the choice and return `live` for
supported MCP updates. Observed inventory must show the frozen server alias,
`navigate` and its full MCP name alongside native Read. Disabling removes the
server and its MCP names while preserving native names. The same query stays
running, with no automatic interruption or additional model query. A transient
SDK status failure must mark the server unverified while preserving previously
observed names; a successful refresh restores verified status. Explicit empty
tool lists and live removal still clear the corresponding MCP names.

Selecting the instruction guide reports `restart_required` and leaves the
running query's initial plugins unchanged. Do not assume that initial list is
empty: bundled instruction defaults can already be loaded. A cold session saves
its choice for `next_query` without loading a query. The shared `application`
field describes configuration application; connection/consent state remains in
observed inventory, not an unconditional tool-availability claim.

Inspect `session-tool-activation.json`: pass, liveActivationWired and
resourcesStopped must be true. Results must contain enabled/disabled/instructions/
cold replies, unavailable/recovered status and observed names, interrupts=0 and queryCount=1. The baseline
public RPC refuses the unknown operation. The separate first-red inventory
regression shows MCP server status changing while the combined tool-name list
stays stale. Preserve both failures and the final passing evidence.

Focused suites cover the operation, runtime query owner, inventory, AgentSession,
canonical preference writer and legacy translator. They also verify refusal of
non-human callers, failed writes, malformed keys/status, SDK errors, and a late
application after its owner is invalidated. ACP disclosure is unit-tested as
restart-required/unverified without touching its query; a real ACP transport,
provider tool execution and UI controls are not verified here. Slice 7 owns the
Use here button and Advanced settings. The shared wrapper saves evidence then
removes owned temporary HOME/data/TMPDIR after all resources close in finally.
