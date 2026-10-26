# SDK permission mode is explicit before the first turn

Follow shared isolation, resource-check and cleanup rules in `../SKILL.md`.
This proof invokes the actual QueryOptionsBuilder, SDK and native Claude CLI,
using an isolated HOME whose synthetic user settings set defaultMode to auto.
No provider key or model server is needed: the child endpoint is loopback port 1
and the proof reads the real system/init event before any successful model turn.
It does not use the human's settings, credentials, live daemon or database.

```bash
TMPDIR="$PWD/.git" bash .claude/skills/verify/proof-run.sh \
  "$PWD/.git/sdk-permission-fixed" .claude/skills/verify/sdk-permission-spawn.ts verify
```

The default native path is the installed Darwin ARM64 SDK platform package.
For another platform, set VERIFY_CLAUDE to an absolute installed SDK CLI path
using the shared environment forwarding rule in SKILL.md. Never copy credentials.
The helper invokes the production flag-settings writer and the real prepared
worker policy, leaves its bypass restriction and OS sandbox enabled, and waits
for every owned native child to exit before removing its synthetic worker runtime.
The wrapper saves evidence before removing the remaining synthetic HOME/data.

Inspect `sdk-permission-spawn.json`:

- An ordinary bypass session must emit system/init with bypassPermissions.
- A prepared worker whose local policy disables bypass must emit default, retain
  its sandbox, and never inherit auto from user settings. An explicit plan mode
  remains plan (covered by the builder regression).
- A separate native control request must reproduce the exact disabled-by-settings
  bypass refusal. This proves why a prepared worker cannot switch; it does not
  override the restriction. QueryRunner must no longer attempt a deferred switch.
- The synthetic user settings stay byte-for-byte unchanged, childrenStopped and
  workerRuntimeRemoved are true, and pass is true.

The same helper's baseline mode expects auto in both native init events and the
same refused control request. Save that evidence before the production fix.
The SDK canUseTool-shadowed diagnostic for an ordinary bypass query is expected:
AskUserQuestion interception remains on PreToolUse, tested through runner startup.
The old deferral only hid that warning and allowed user auto mode to leak in.

This verifies native SDK spawn and permission admission. It does not exercise
provider billing, a successful model turn, browser UI, or OS sandbox enforcement.
Run the builder permission cases and runner/startup-gate suites too; report host
sandbox-exec failures as environment failures rather than disabling enforcement.
