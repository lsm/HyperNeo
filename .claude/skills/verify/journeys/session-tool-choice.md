# Canonical session-choice foundation (Tools slice 4)

Use the shared isolated in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/session-tool-choice.ts`. No HTTP mock or fixed port
is needed. The helper owns an ephemeral daemon, scripted SDK and an in-memory
MCP protocol server exposing `navigate`; it never launches an external command.

This historical foundation harness compares legacy defaults captured at creation
with what the current production builder passes to the scripted SDK and what
`session.getToolInventory` reports over WebSocket. Explicit canonical consumer
activation is covered by `canonical-sdk-tool-inputs.md`; the one-click UI remains
a later slice.

Pass requires four sessions created through the public RPC door:

- Registry on plus wrapper off: no browser alias or browser tool.
- Wrapper on: the wrapper alias, never the registry name, and `navigate`.
- Session skill veto: no browser alias or browser tool.
- Session MCP override off: no browser alias or browser tool.

Every selected projection alias must equal the SDK options and observed inventory.
The helper asserts the outcomes, writes `evidence/session-tool-choice.json`, and
closes its daemon, queries, socket and MCP resources in finally. Read the JSON:
`pass` must be true and all four cases present. No GUI or canonical activation is
claimed. One-click activation and migration require later slice journeys.

Run the focused `session-tool-choice.test.ts`, `resolve-mcp-servers.test.ts` and
`query-options-builder.test.ts` suites from packages/daemon. They also pin frozen
choices despite catalog edits, explicit selection overriding old preferences,
Space/policy restrictions, unknown definitions, alias collisions and alias lifetime.
Transport validation and reserved runtime-server composition stay with the existing
builder; this model represents intent, not proof of attachment or authorization.
