# Use one saved session tool choice (Tools 7a)

Use SKILL.md's guarded metadata-only setup. Build the web package first, then
start the activation helper in a fresh absolute evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/session-tool-activation.ts --show-panel
```

The wrapper's temporary `proof.log` prints the actual session URL and the
helper PID. Open that URL in an attended browser, then Chat actions → Tools.
This is the built product and actual WebSocket operation, not a component preview.
The helper owns an isolated daemon, scripted SDK and synthetic in-memory MCP
server; no real provider, external server process or existing DB is used.
Keep the helper alive throughout the attended checks. Do not run an unattended
GUI test. Use the printed PID only, and finish with SIGUSR1, not SIGTERM:
the daemon's SIGTERM handler also begins shutdown and would falsely count a
shutdown interrupt as a tool-change interrupt.

Functional and visual QA inventory:

- Initially Browser is saved off. It has one primary Use here button despite
  both its skill and backing registry default being off. Wrapper/server rows
  must fold into one choice; attachment is a separate observation.
- Click Use here: Browser. The saved choice turns on, application says it was
  applied to the running session, and the observed alias shows Attached · 1 tool.
  Expand observed names to see `mcp__<saved-alias>__navigate` and native Read.
- Stop using here: Browser restores saved off and removes its observed tool.
- Use here: Guide reports restart required, without interrupting the query or
  pretending the instructions have already loaded. Do not click a reset/stop.
- Close/reopen Tools and reload the page. Guide's saved-on choice must survive;
  Browser remains off. No new SDK query may be started by those actions.
- On a narrow viewport, first close the navigation drawer so it does not obscure
  the modal. An open drawer is not evidence of a usable modal.
- Filter tools and clear the search. The primary rows must remain readable and
  usable, with no horizontal clipping, on desktop and a narrow viewport.
- Expand Advanced settings. Legacy selectors and prompt/settings-source controls
  are available there during the compatibility window. They are not the primary
  Use here picker. Slice 8 removes obsolete duplicate selectors.
- Exploratory: enabling Space Coordination in this unscoped session is refused
  with a reason and leaves its saved choice off. Network failures, duplicate
  clicks while pending, late old-session replies and all application variants
  are additionally covered by component tests.

Retain dialog text and screenshots for initial, applied, removed and restart
states, plus a narrow-viewport screenshot and viewport bounds. Wait until the
modal is visibly rendered before capturing it; a screenshot of only the chat
behind it is inconclusive even if dialog text was already present in the DOM.
Close the temporary tab and signal the printed helper PID with SIGUSR1.
`session-tool-activation.json` must report pass, panelVerified and resourcesStopped;
its panel facts must show enable and removal applications, the saved Guide,
workerQueryCount=1 and interrupts=0. The web app also performs a disposable
model-list SDK probe; the helper records its creation/interrupt separately as
`discoveryProbes`. That probe is not the session query. The wrapper saves evidence and deletes temporary
HOME/data/TMPDIR. Also run the helper without the panel flag in a separate fresh
run to retain the existing activation RPC checks.

Baseline evidence uses the same helper with `--show-panel-before` and the web
build from before this slice: the globally-off Browser checkbox is disabled and
there is no Use here control. The initial failing component reproduction is
committed separately before the picker. Slice 7a does not verify real Chrome
navigation, provider execution, ACP transport, Space task activation controls or
catalog/Space default labels; those remain distinct slices.
