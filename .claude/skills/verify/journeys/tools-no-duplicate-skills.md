# One skill picker in Tools (Tools 8b)

Use shared setup in `../SKILL.md` and the attended browser setup in
`tools-use-here.md`. Build web with the resource guard, then run the existing
session-tool-activation.ts helper with --show-panel through proof-run.sh in a
fresh absolute evidence directory. This owns an isolated daemon, scripted SDK
and in-memory synthetic MCP server; no real provider, fixed port or external
registry command. Read the printed URL and exact helper PID from its log.

Open Chat actions → Tools and expand Advanced settings. The canonical Use here
section must be the only skill picker: no second Skills group, Filter skills
box, legacy skill checkboxes or global-veto hint. The remaining MCP compatibility
controls and prompt/settings-source controls must still render. Do not edit
those compatibility controls during this proof.

Use here Browser must work despite its legacy catalog flag being off. Observe
Saved choice on, live application, Attached · 1 tool and the actual
mcp__<saved-alias>__navigate name. Stop using here removes it. Use here Guide
saves on with restart-required disclosure. Keep Advanced expanded while checking
there is no second skill selector after these changes. Save desktop and narrow
screenshots and browser text, with the modal unobscured.

Close the tab and send SIGUSR1 only to the printed PID. Require wrapper exit
zero and session-tool-activation.json pass, panelVerified and resourcesStopped,
with enabled/removed applications, saved Guide, workerQueryCount=1 and interrupts=0.
The shared wrapper saves evidence and removes owned daemon data. Run ToolsModal
observed/helper tests and SessionToolChoices tests too.

Before deletion use the same helper with --show-panel-before and expand Advanced
without edits. Preserve the duplicate skill selector and its disabled Browser
checkbox alongside the working canonical Use here action. The baseline helper's
panelVerified=false is not passing UI proof. Commit the failing component test
before deletion. This slice does not remove serialized preferences, daemon
setters or the remaining MCP controls, and does not prove real provider/ACP use.
