# Session tool preference coordinator (Tools 6d.2a)

Use shared isolated in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/session-tool-writer.ts`. No fixed HTTP port, model
registration or GUI is required. The helper owns a fresh daemon DB, two boots,
its WebSockets and an in-memory MCP fixture. No executable or SDK query starts.

This is a Build slice: invoke the coordinator inside the isolated daemon and
observe persisted state through the existing RPC read doors. RPC setters and
cached-session synchronization are not wired yet; 6d.2b owns them. Unload only the
owned test session before cold readback. No SDK/UI flip before 6d.5.

Pass requires:

- Seed disabled synthetic definitions and a manual session, then save legacy
  disabled IDs and a canonical off fixture. Invoke the coordinator to remove both
  vetoes; canonical choices and legacy tools persist together. Frozen MCP aliases
  and the native Read preset survive cold session.get readback.
- Disable and re-enable the instruction with skills requests that omit optional
  tools. Cold RPC reads must show both the canonical choice and matching legacy
  disabled IDs changing, while advanced settings are preserved. Record
  requestOnlyDisableEnableRoundTrip=true.
- Set the session override and inspect session.mcp.list. Persist global defaults,
  then clear the override through the coordinator: it inherits that default while
  retaining the frozen alias and unrelated instruction choice.
- Hold the real worker commit after capture, edit the override through the existing
  RPC door and release: refuse the stale write without a success notification.
- Inject an override SQL failure: neither canonical state nor legacy tools changes.
  Only accepted writes reach the committed callback.
- Restart the owned daemon. Canonical/legacy state persists; inventory remains
  not_running and the synthetic MCP protocol fixture lists navigate.

Read evidence/session-tool-writer.json: pass=true, matching selection/rpcReadback,
all coordinator/clear/race/rollback/notification/restart flags true, and false
activeConsumerWired/sdkApplyVerified/queryStarted flags. All resources close in
finally; the held commit is released even if the concurrent RPC fixture fails.

The coordinator captures session/catalog/override/default facts in one synchronous
read transaction, then passes complete source guards to the atomic worker commit.
It reuses the legacy adapter and choice-change pipeline. Skills request IDs are
also the authoritative legacy disabled list; optional settings cannot replace it.
MCP requests retain captured skill vetoes even if optional settings differs. Corrupt stored defaults
throw without writes; present-null session selection and unsupported versions never
fall back to current catalog preferences. Later wiring owns caller authorization,
cache updates and event publication through the committed callback.

Run write-session-tool-preferences.test.ts, legacy-tool-preferences.test.ts,
change-session-tool-choice.test.ts and tool-preference-commit.test.ts. Fixtures also
cover matching Space defaults, concurrent definition/default edits, missing/closed
sessions and no notification on rejected writes. No active RPC save, SDK attachment
or one-click Use here UI is claimed by this foundation proof.
