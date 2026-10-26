# Human-approved worker Unix sockets

Read shared setup in `../SKILL.md`. No credentials or real signing keys are needed.
Run the repeatable isolated-daemon proof from the repository root:

```bash
TMPDIR="$PWD/node_modules/.cache" bash .claude/skills/verify/proof-run.sh \
  "$PWD/socket-evidence" .claude/skills/verify/worker-unix-sockets.ts
```

`worker-unix-sockets.json` must report `pass`: a fresh test HOME's git signing
configuration and SSH IdentityAgent produce one startup card; repeated requests
reuse their card; human Allow and Decline persist across a real isolated daemon
restart; removing an allowed entry over the settings RPC changes the next Codex
policy. The settings component test opens the actual settings component and clicks
Remove. This is component interaction evidence, not a browser screenshot.

Policy tests in `worker-unix-sockets.test.ts` inspect the written Claude settings
and generated Codex configuration. Both include only the approved path and drop
it on the next policy read after removal. Only filesystem runtime preparation is
mocked for this policy test; it does not establish OS socket enforcement.

## Post-deploy socket-connect proof

The implementing Codex session could not start a nested native sandbox:
`sandbox-exec: sandbox_apply: Operation not permitted`. Run this on a host that
can launch the real worker sandboxes. Do not change machine sandbox settings.
Use the existing native-worker journey's shared isolation, with the socket mode:

```bash
bash .claude/skills/verify/resource-check.sh && \
RUN=$(mktemp -d /private/tmp/hn-sockets-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn VERIFY_WORKER_SOCKETS=1 \
  VERIFY_CLAUDE="$(command -v claude)" VERIFY_CODEX="$(command -v codex)" \
  bun .claude/skills/verify/worker-sandbox.ts "$RUN"
```

The helper owns two synthetic Unix echo sockets outside all worker roots and
approves exactly one through the isolated settings RPC before starting workers.
Real Claude, Codex and SDK Bash probes must each record
`{"allowed":true,"denied":false}` in `evidence/{claude,codex,sdk}-sockets.json`.
The Codex CLI must accept the generated network-proxy configuration; a config
parse error or two successful connections fails this journey. The helper closes
its sockets, daemon and model in finally. Retain evidence, then delete only the
owned synthetic run. This proves socket connections, not real commit signing.

In the isolated web UI, Settings > Neo model must show Worker Unix sockets,
each exact path and Remove. Removing one must update the next worker's generated
policy while leaving already-running workers unchanged. A worker report naming
another absolute socket is handled by Neo's `neo.workerSocket.ask` operation;
workers themselves must be rejected by that operation and the human-only answer
operation. Never use a real agent socket for this journey.
