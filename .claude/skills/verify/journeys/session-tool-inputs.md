# Canonical tool input/default preparation (Tools slice 6b)

Use shared isolated in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/session-tool-inputs.ts`. No fixed port, HTTP model,
provider registration or GUI is required. The helper owns a fresh synthetic daemon,
its WebSocket and an in-memory MCP protocol server exposing `navigate`. No external
MCP executable or SDK query starts.

This helper checks preparation directly; initial-tool-defaults covers constructor
and cache wiring. SDK and UI consumers remain later slices. Supplied
canonical defaults must already represent the chosen global/Space/profile scope;
that inheritance and legacy compatibility belong to 6c. Initial veto IDs are a
required argument, supplied from captured session/workflow facts at creation.
Existing selections use projection directly and never reapply legacy preferences.

Pass requires:

- Seed a disabled synthetic MCP server/wrapper and instruction skill via RPC.
- Supplied on defaults produce the selected instruction and frozen MCP alias,
  independent of old global off flags. Missing defaults alone use legacy rules.
- Initial wrapper/instruction vetoes turn the corresponding new defaults off,
  leaving the supplied template unchanged. Policy remains authoritative.
- Feed the projected catalog entries to the existing reserved-name/runtime merge
  helper. Operations and runtime servers survive; the reserved catalog alias is
  renamed. This is composition-boundary proof, not live SDK attachment.
- Persist the prepared selection through the real CAS, unload only this owned
  session, then verify RPC readback. The native preset stays Read and current
  inventory stays not_running.

Read `evidence/session-tool-inputs.json`: pass=true, matching initial/rpcReadback,
correct aliases and protocolTools, runtimeAndReservedMergePreserved=true, and
initialCreationWired=true and explicit false
activeConsumerWired/sdkApplyVerified/queryStarted flags.

Focused suites: session-tool-inputs.test.ts, session-tool-choice.test.ts,
change-session-tool-choice.test.ts and query-options-builder.test.ts. They cover
partial/all wrapper vetoes, unmapped aliases, missing/colliding definitions,
Space-only instructions, unsupported versions and no surprise catalog additions.
Transport conversion/validation, plugin paths and actual query composition remain
with the existing SDK builder. Run session-tool-choice.md for unchanged legacy
scripted-SDK/MCP parity. No new live attachment or one-click control is claimed.
