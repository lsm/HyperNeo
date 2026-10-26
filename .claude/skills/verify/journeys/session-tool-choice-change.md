# Atomic choice-change foundation (Tools slice 6a)

Use the shared isolated in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/session-tool-choice-change.ts`. No fixed port, HTTP
model mock, provider registration or GUI is needed. The helper owns two ephemeral
daemon boots and a fresh synthetic database. External registry servers are disabled.
The synthetic MCP command is never launched.

This helper covers the original Build foundation: it invokes the pipeline directly
inside the isolated daemon and commits through the real DB gateway/CAS primitive.
It does not exercise later adapters, SDK building, session creation or UI.
`session-tool-activation.md` now covers the authorized operation and live application.
Legacy initialization requires an explicit pinned-slot reader using the captured
snapshot metadata. The fixture reuses the startup migration's existing reader.

Pass requires:

- Create a manual session and globally disabled synthetic server/wrapper via RPC.
- Enable its one canonical choice; persist the original wrapper alias as JSON
  object data while preserving ordinary settings. No query starts.
- Unload only this test session, then session.get over WebSocket must return the
  persisted selection. Repeating the same change reports unchanged.
- Hold a selection write after capture. Change autoScroll through the public RPC,
  then release the stale write: it must be superseded, with no selection loss.
- Restart the owned daemon; RPC readback retains the selection and ordinary edit.
- Create a legacy worker with a pinned workflow veto, then remove that veto from
  the workflow's current version. Changing an unrelated choice must keep the
  pinned-off tool disabled in RPC readback and after restart.

`evidence/session-tool-choice-change.json` must have pass=true, matching reloaded
and restarted selections, matching pinnedLegacySelection/pinnedRestarted,
concurrentEditWon=true, and explicit false activation
and SDK-apply flags. The helper closes all resources in finally.

Focused suites: change-session-tool-choice.test.ts, session-tool-choice.test.ts,
session-runtime-settings-write.test.ts, runtime-settings-commit.test.ts and
runtime-settings-commit-owner.test.ts. They pin refused policy/Space/definition
changes, ambiguous aliases, future versions, closed targets and same-ID recreation.
They also preserve captured legacy vetoes when a different tool is selected.
Run the existing session-tool-choice journey for unchanged scripted-SDK/MCP parity.
No one-click control, live tool attachment or permission to execute is claimed.
