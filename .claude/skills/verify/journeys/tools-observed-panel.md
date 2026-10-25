# Truthful Tools panel (approved Tools slice 3)

Use the shared isolated environment in SKILL.md. Build the web package first.
Then run the slice 2 helper with `--show-panel` in a fresh synthetic run:

```sh
RUN=$(mktemp -d /private/tmp/hyperneo-tools-panel-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/tools-live-capture.ts "$RUN" --show-panel
```

No HTTP model mock or port preflight is needed. The helper owns its ephemeral
daemon, static web server, scripted SDK and real in-memory synthetic MCP server.
It disables external registry servers. Synthetic configured server commands are
never executed by the scripted SDK. A configured-only SDK row is deliberately
absent from observed init/status. The returned API facts are retained in
`evidence/live-inventory.json`; the panel URL and exact owned PID are printed.

Open the printed actual session URL in an attended browser. Open Chat actions →
Tools. Do not use an unattended GUI test or a component-only preview for this proof.

1. The observed browser must say `Attached · 1 tool`; the configured browser
   explicitly absent from the SDK must say `Configured but not attached yet`
   with a plain reason. No configured-only row may appear under observed MCP.
2. Playwright must say `Instructions loaded · prerequisites unverified`.
   This asserts instruction metadata, not a working browser or its permission.
   Expand observed tool names to inspect the actual SDK names. Reasons must
   wrap in skill cards and remain readable, without depending on hover.
3. With Tools still open, send SIGUSR2 only to the printed helper PID. This
   changes its scripted SDK status to needs-auth. Click Refresh running tools;
   the browser rows must say sign-in or consent required, with no attached claim.
4. Send SIGUSR1 only to that PID. Its scripted turn ends through the actual
   daemon. Without clicking Refresh, the open panel must lose observed attachment
   and loaded instruction claims and show session not running. This proves the
   query lifecycle invalidation event reaches the actual panel.
5. Retain before/after, sign-in and ended screenshots plus the API evidence and
   browser text. Close the temporary tab and send SIGTERM only to the helper PID;
   its finally closes the web server, daemon and MCP transports.

For the refresh review regression, add `--slow-status` beside `--show-panel`.
SIGUSR2 then makes status reads take 2.5 seconds. After the initial attachment
is visible, send that signal and click Refresh. During the pending read, the
confirmed server, tool count and instruction observation must remain visible;
after the reply they must change to sign-in/consent required. Session changes
and disconnects must still clear prior observations. The baseline 74a0ffc98d
instead collapses observed MCP, shows zero names and falsely labels the known
browser not attached while waiting. Retain refresh-before/after screenshots and
browser text; a resolved read alone does not verify the pending interval.

Space TaskToolsModal is explicitly deferred by Neo to follow-up #8648, immediately
after this PR merges, to keep this slice within 200 production lines. Its original
configured-only source is not a verified observed surface in this PR.

Baseline: the unchanged slice 2 panel shows the configured absent browser as
`Active in this session` and configured-only as a runtime tool. The six rendering
reproductions were committed before the fix at cde1191533. Copy only the updated
verification helper source into a baseline checkout when reproducing attended
UI; never copy a DB. The source helper is not the panel implementation.

Focused web suites ToolsModal.observed.test.tsx and ToolsModal.test.tsx cover
rendering, all SDK status reasons, unknown/zero tools, disconnect/reconnect,
late old-session reads and refresh. Run the slice 2 non-GUI RPC journey in a
separate fresh run too. No native browser execution, real ACP transport,
activation control migration or real user installation is verified here.
