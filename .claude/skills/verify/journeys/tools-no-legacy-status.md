# Tools has one canonical runtime-status projection (Tools 8a)

Use shared setup in `../SKILL.md` and the interaction setup in
`tools-use-here.md`. Build web with the resource guard, then run the existing
scripted SDK helper with `--show-panel` through proof-run.sh in a fresh absolute
evidence directory. It owns its daemon and synthetic MCP server, no fixed port,
external registry commands or real provider. The log prints the session URL and
exact helper PID. Open Tools in an attended browser; no unattended GUI.

Expand Advanced settings. The duplicate Skills selector was removed in 8b.
Remaining legacy MCP selectors must have no second attachment/status claim: no legacy
Off / skill-disabled / not-injected labels, dots or duplicate tool counts.
The canonical Use here rows and Observed MCP section retain the real status.
The prompt preset and settings-source controls remain available.

Follow tools-use-here.md: Use here Browser, inspect its observed navigate name,
Stop using here Browser, then Use here Guide and read restart-required. Check
Advanced after each change: it must not reintroduce the removed labels. Save
screenshots/text for the expanded initial and applied states and one narrow
layout. Do not toggle the old selectors or save an unrelated Advanced change.

Close the tab and send SIGUSR1 only to the printed PID. Require wrapper exit
zero and session-tool-activation.json pass, panelVerified and resourcesStopped,
with enabled/removed applications, saved Guide, workerQueryCount=1 and interrupts=0.
The shared wrapper saves evidence and removes all owned daemon data.

Before deletion, run the same helper with --show-panel-before and expand
Advanced without making changes. Preserve the duplicate legacy status text and
screenshot as baseline evidence. The baseline helper's panelVerified=false is
not passing UI proof. Commit the failing component reproduction before deleting.
Retain all lifecycle/status rendering regressions, targeting the primary picker
instead of removed legacy decorations. This does not verify real providers,
OS browser execution, ACP transport or deletion of the remaining selectors.
