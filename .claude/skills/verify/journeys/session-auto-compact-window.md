# Session absolute auto-compact window

Run `session-auto-compact-window.ts` through `proof-run.sh` with pinned Bun.
The helper owns an isolated daemon, disposable HOME/DB/SDK settings, and random
loopback ports. Provider discovery uses synthetic responses and the real Kimi
configuration points SDK traffic at the owned loopback fixture.

Create a session through the authenticated session.create RPC with
SessionConfig.autoCompactWindow=450000. Require the persisted field and SDK
settings to contain 450000, with CLAUDE_CODE_AUTO_COMPACT_WINDOW absent from both
query options and the actual SDK child environment. Start the real SDK query and
record its getContextUsage response. A second session without the field must
retain the provider-derived window in settings and the SDK child environment.

Retain session-auto-compact-window.json with passed and resourcesClosed true,
and wrapper exit 0. The helper closes SDK queries and the daemon before the
wrapper saves evidence and removes temporary data. This checks session config
and native SDK startup through the RPC path. Slash-command parsing is outside
this setting-field proof.
