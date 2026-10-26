# Work sessions advertise only worker operations

Sessions started through the `work.start` door carry `config.toolProfile: 'worker'`.
Their operations tool does not list `neo.*`, `pack.*` or `work.*` operations. This
only changes what is advertised: calling one by name is authorized by `policy.roles`
exactly as before.
Hand-made sessions (`session.create`) have no profile and list the full catalog.

Use the shared isolation setup in `../SKILL.md`, then:

```sh
RUN=$(mktemp -d /private/tmp/hn-tool-profile-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  LOG_LEVEL=error bun .claude/skills/verify/tool-profile-listing.ts "$RUN"
```

The helper boots an isolated in-process daemon on an ephemeral port with a synthetic
Git folder. It calls `work.start` (adapter `hyperneo`) and `session.create` over the
daemon's WebSocket RPC, then calls `operations.list` through each session's real
`hyperneo-operations` MCP tool. No model turn or provider key is needed.

End state, from `evidence/tool-profile-listing.json`: `workerProfile` is `worker`,
`manualProfile` is null, `workerOrchestration` is empty, `manualOrchestration` includes
`work.start`, `workerHasMessageSend` is true, and `clientProfileRefused` is true: a
`session.create` that supplies `config.toolProfile` is refused, since only the daemon
assigns profiles.
