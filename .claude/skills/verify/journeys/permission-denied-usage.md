# Auto-denied SDK tools preserve the session

Read `../SKILL.md`. This journey uses the real SDK through an isolated daemon's
public RPC door. Its anonymous custom provider is a synthetic Messages endpoint
on its own ephemeral loopback port. No key, fixed mock port, real provider,
GitHub call or GUI is needed. The helper owns its daemon, mock and fresh DB.

Run from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-permission-denial-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/permission-denied-usage.ts verify "$RUN"
```

The helper disables external registry MCP servers and configures only its fresh
synthetic settings. `session.create` selects `dontAsk` with the native Bash tool.
The fake model requests a marker-file write inside the synthetic workspace.
The SDK denies it through its existing permission mechanism; the helper adds no
command-line policy. Inspect `evidence/permission-denied.json`:

- Public `message.send` produces one persisted `system.permission_denied` with
  its original string body. No session reset/error is emitted.
- The model finishes after the denial. A second public message also completes
  with the same SDK session identity, proving the session remains usable.
- The denied marker file is absent. Existing assistant usage remains 20 input
  tokens instead of being replaced by zero defaults.

At reproduction commit `6d9bb5ff81`, use `before` instead of `verify` with a fresh
run. The actual SDK string advisory triggers the readonly-property TypeError;
the denial is missing from the public transcript and the daemon emits the reset
toast text. A path-scoped Read deny is inconclusive for this bug: the SDK does
not emit this best-effort advisory for that denial path. Use the native Bash
`dontAsk` fixture above.

The helper closes its WebSocket, daemon and mock in finally. Preserve the JSON
and command output outside the worktree. Bun execution is verified; Deno, live
provider behavior and GUI rendering are not verified by this journey.
