# Legacy tool preference adapters (Tools slice 6c)

Use shared isolated in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/legacy-tool-preferences.ts`. No provider turn, fixed
HTTP port or GUI is needed. The helper owns a fresh daemon, WebSocket and in-memory
MCP protocol fixture; no external MCP executable starts.

This is a Build slice. Existing RPC setters and SDK consumers stay unchanged.
The pure adapters receive captured configuration/catalog facts; later wiring must
use those same facts for the guarded CAS, select the matching Space/default scope,
and handle legacy-row persistence and cached-session/application synchronization.
The batch extension reuses the existing choice mutation pipeline and commits once.
Default updates require the exact canonical edits from the legacy request, as well
as before/after catalogs: an old wrapper-off gate can mask a registry toggle in the
old effective projection. Alias-only catalog changes preserve explicit choices.

Pass requires:

- Seed globally disabled synthetic wrapper/instruction rows and a manual session
  via RPC, then save legacy disabled IDs through the existing tools.save door.
- Translate removal of those two vetoes. A denied target refuses the whole batch
  without a write. The accepted batch performs one real CAS and preserves aliases.
- Unload only this owned session. RPC readback matches both canonical choices,
  while legacy fields and the native Read preset remain unchanged.
- Prepare a default edit turning one server off. A future initial selection is off;
  the existing session read through RPC remains on. Matching Space defaults take
  precedence; an inbox uses global defaults. Clear-override translation uses the
  chosen default, not the old current-session override.
- Hold captured settings, perform an ordinary RPC edit, and reject the stale batch.
- The projected alias matches the frozen binding, the MCP fixture exposes navigate,
  and session inventory remains not_running.

`evidence/legacy-tool-preferences.json` must have pass=true, matching accepted and
reloaded values, existingSessionStayedFrozen/policyRefusedWholeBatch/staleBatchRefused
true, and false activeConsumerWired/sdkApplyVerified/queryStarted flags.
The helper closes only its resources in finally.

Focused suites: legacy-tool-preferences.test.ts and change-session-tool-choice.test.ts.
They also cover contradictory folded wrapper edits, explicit off defaults, missing
keys, unsupported versions, Space precedence, removals/renames, alias handoffs and
no partial or stale writes. Run session-tool-choice.md for unchanged scripted SDK/MCP
parity. No active legacy compatibility, new SDK attachment or Use here UI is claimed.
