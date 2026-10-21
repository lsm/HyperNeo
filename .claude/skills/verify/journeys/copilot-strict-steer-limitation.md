## Copilot strict steer limitation (optional slice 6)

Use the shared isolation rules in SKILL.md. From the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-copilot-steer-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/copilot-lifecycle.ts 9386 "$RUN" steer
```

This drives the actual isolated daemon through `operation.invoke` with the pinned
SDK and a synthetic Copilot executable. `work.adapters` must omit steer from
capabilities and return `unsupportedCapabilities.steer` explaining the same-turn
limitation. `work.send mode: steer` must return unsupported with that explanation
for active, unknown and stopped refs. Compare fixture traffic before/after each
refusal: there must be no send, enqueue, resume or other runtime request. The
active original receipt must still be running and stoppable. Existing lifecycle
checks in the helper also run, proving receipt-bound completion and cleanup.

Evidence: `$RUN/evidence/observed.json` includes catalog, operation replies and
fixture traffic. The helper closes its socket/daemon in `finally` and verifies
fixture PIDs have exited. The regression first fails at the public catalog's
missing explanation. Run the focused Copilot adapter/worker/send-queue/discovery/
history suites and work-operation routing suites serially. No real CLI, account,
credentials, port 8399 or GUI is used. This proves explicit refusal and no fallback
at the user operation door, not native Copilot scheduling or app handover.

The pinned-source research and rationale are in docs/design/copilot-adapter.md,
“Slice 6 decision”. Supporting a best-effort immediate input is a distinct contract.
