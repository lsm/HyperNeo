# Canonical SDK consumers (Tools 6d.5)

Read shared setup in `../SKILL.md`. Check `memory_pressure` before each heavy
run; require at least 25% free and run one heavy job at a time.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/canonical-sdk-tool-inputs.ts
```

This helper owns an ephemeral isolated daemon, synthetic database, scripted SDK
and real in-memory MCP client/server exposing `navigate`. No external MCP command,
provider traffic, browser, credentials from the environment, or fixed port is used.
The synthetic provider credential is stored only through RPC in this run's DB.

Public session/message/inventory RPCs must show the following:

- A persisted on selection reaches SDK MCP and instruction-plugin options despite
  old catalog-off and session skill vetoes. The frozen alias is preserved.
- A persisted off selection attaches nothing after catalog defaults turn on.
- The operations server and an explicit runtime server survive composition;
  a conflicting frozen catalog alias is renamed using the existing merge helper.
  Attach the fixture runtime server through the owned AgentSession method;
  human session configuration intentionally cannot inject trusted runtime servers.
- A runtime slot veto assigned after session creation removes selected wrapper MCP
  and instruction plugins from the next query without rewriting the saved choices.
- Observed inventory reports the scripted query's actual submitted MCP aliases
  and tool names supplied by the in-memory MCP protocol. Native Read stays Read.

The helper writes a choice through the existing internal CAS and reloads only its
own session before querying. Activation and the one-click UI remain later slices.
Inspect `canonical-sdk-tool-inputs.json`: pass and canonicalSdkConsumerWired must
be true, with all four cases present. Before the fix the on case attaches no
MCP alias or instruction plugins. Save that failing reproduction before wiring.

Run the canonical builder regression cases, full query-options-builder suite and
session-tool-inputs/resolver tests. They also require one consistent captured query
selection, Space-only restrictions, invalid-transport exclusion, unknown-version
refusal, removal/restoration when slot restrictions change and no surprise attachment
after catalog edits. Run the existing session-tool-choice journey to retain migration parity for legacy selections.

This proves SDK input wiring and observed facts with a scripted SDK, not real
browser execution, provider plugin discovery, live application or UI controls.
The shared wrapper retains evidence and immediately removes owned daemon data
after the helper closes all resources in `finally`.
