# Freeze existing tool choices (Tools slice 5)

Use the shared isolated in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/session-tool-migration.ts`. No HTTP mock, provider
registration, SDK query or GUI is used. The helper first creates a fresh synthetic
legacy database, then starts and stops two owned ephemeral daemons against it.
It never reads or copies an existing database.
A paused synthetic session has malformed config: both daemons must still start,
healthy session RPCs must work, and the malformed source value must stay unchanged.

Pass requires `session.get` over the real WebSocket RPC door to report version-1
canonical selections for four pre-existing sessions: on, session skill veto off,
Space MCP override off, and session override on despite Space off. All retain the
original wrapper alias and native tool preset. Global and Space new-session
default snapshots preserve their different effective preferences.

After the first boot, public settings RPCs disable the synthetic skill and server.
The ordinary session update RPC accepts a full config echo with the unchanged
canonical selection, strips that owned field from the write, and preserves the
snapshot while applying the ordinary edit. Changed or new selections are refused.
An ordinary Space config replacement changes the concurrency limit while retaining
the frozen defaults. Space creation/update and global settings RPCs must refuse
caller-supplied defaults, including empty snapshots, before any settings change.
A separate synthetic Space verifies malformed-config replacement through the
repository in the running daemon; normal Space settings updates use the RPC door.
On the second boot the same session selections, aliases and default snapshots
must remain unchanged. The helper asserts every result, closes all resources,
and writes `evidence/session-tool-migration.json`. `pass` must be true and both
boot records present.

Focused tests are `session-tool-selection-migration.test.ts`,
`session-tool-choice.test.ts`, `create-session-config.test.ts`,
`resolve-mcp-servers.test.ts` and `query-options-builder.test.ts`. They also cover
pinned workflow-slot vetoes, preservation of future versions and unrelated config,
newly found legacy sessions, malformed/non-object configs skipped without rewriting,
empty fallback for malformed context/metadata, and transaction rollback on write failure.

This slice persists choices only. Existing SDK tool building and settings setters
still own active behavior; canonical activation, new-session creation from these
defaults, compatibility setters, migration UI and one-click enable are not claimed.
Those are follow-up wiring slices. Native tool profiles are preserved verbatim.

For full-config echo compatibility, also run the existing
`tests/online/convo/neo-publication-sdk.test.ts` with `vitest.online.config.ts`
from packages/daemon under the shared isolated HOME/data environment and
`HYPERNEO_TEST_DISABLE_SANDBOX=1`. It owns its loopback model API and synthetic
GitHub command. Both store and daemon-gh cases must pass with the real SDK;
this is transport proof, not proof of OS sandbox enforcement.
