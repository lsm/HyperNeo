# Space task Tools uses observed inventory (#8648)

Build web first. Use the shared isolated environment in SKILL.md with
`PROOF=.claude/skills/verify/tools-live-capture.ts`, adding `--show-task-panel`.
No HTTP model mock or port preflight is needed. The helper owns an ephemeral
daemon and static web server, scripted SDK and in-memory synthetic MCP protocol.
It creates a synthetic Space and in-progress task, binds the existing synthetic
worker through durable post-approval provenance, and stops its job processor
before seeding; no task or workflow is dispatched. No real HOME/DB/provider or
browser execution is involved.

The printed PANEL URL is the actual `/space/<space>/task/<task>` page. Open it
in an attended browser, choose the Coder recipient, and use the composer's
More options → Tools. A standalone component preview is not proof of this surface.

1. Only observed browser appears with Attached · 1 tool. Configured-only must
   be absent. Expand observed tool names to inspect SDK native/MCP names.
2. Add `--slow-status` when launching. Send SIGUSR2 only to the printed helper
   PID and click Refresh running tools. During the 2.5-second delay, its confirmed
   browser/tool count remain visible with Refreshing tools; after the reply, the
   row must explain sign-in/consent and make no attached claim.
3. Send SIGUSR1 to that helper PID. The open Task Tools panel must automatically
   drop the previous server list and show session not running. No refresh click.
4. Close the temporary tab and send SIGTERM only to that PID. Its finally stops
   both servers, daemon and MCP transports. Preserve before/after/pending/auth/
   ended screenshots, browser text and `evidence/live-inventory.json`.

Baseline source 29f416ff42 shows configured-only as the sole tool on this actual
Space page despite the RPC observing browser. The two failing tests were
committed at 72ffec6920 before implementation. For an attended baseline, build
that original TaskToolsModal source with the current verification helper; copy
source only, never a DB. Restore the fixed source before its final build/checks.

Focused web suites: TaskToolsModal.test.tsx, TaskSessionChatComposer.test.tsx,
ToolsModal.observed.test.tsx and ToolsModal.test.tsx. They cover query end,
disconnect/reconnect, stale session reads, empty/unknown/error and status reasons,
and pending refresh. A real ACP transport, executing MCP/native tools, activation
settings and migration remain unverified/outside this slice.
