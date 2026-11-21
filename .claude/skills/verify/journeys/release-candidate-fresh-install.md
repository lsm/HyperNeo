# Fresh compiled release candidate

Read shared SKILL.md first. Resource-check before each job; one architecture and
one heavy job at a time. Build with the pinned Bun version and the repository's
scripts/build-binary.ts --target bun-darwin-arm64, then bun-darwin-x64. Do not tag,
publish, merge the release PR or touch the live daemon without coordinator approval.

For each CLI candidate, use a fresh short absolute run path, create its home, and run:

```sh
env -i HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  PATH="$(dirname "$BUN"):/usr/bin:/bin:/usr/sbin" \
  "$BUN" .claude/skills/verify/release-candidate.ts "$BINARY" "$RUN" "$COMMIT"
```

The helper installs the binary in its fresh HOME/.local/bin, runs away from the
checkout, binds ephemeral non-8399 ports and blocks credential/app discovery tools.
It uses no real keys. The synthetic loopback provider credential is registered
through RPC and retained only in the isolated database, never exported to the daemon.
The RPC socket reads only the isolated data directory's owner credential; anonymous
WebSockets are refused. The second CLI code must be pending; the isolated owner
approves it with device.pair.approve before the browser claims it over /pair to obtain its
HttpOnly cookie; codes and credentials are never saved to evidence.
Real SDK download uses public npm. Pairing codes and client credentials stay in memory.

steps.json and daemon.log must show installation version/hash, healthy exact-commit
system.build, first-start SDK download, compiled pair producing an approved code,
a real client claiming it and appearing in compiled devices, a Neo chat input whose
real downloaded SDK publishes the scripted visible reply, and work.start creating
a life-admin session which gets an assistant response. The model is scripted; this
is transport/publication proof, not a test of generative model judgment.

The test-mode candidate must not warm embeddings at startup. The proof seeds a
synthetic vector in its isolated database and invokes semantic work search, then
requires Embeddings ready after a fresh asset download. The separate
`compiled-embedding-start-mode.ts` helper checks that a normally built candidate
serves /neo in test mode without starting embeddings; pass the binary and a fresh
run directory. This proof does not claim to exercise production-mode warmup.
Numerical embedding inference is a separate sequential job. Run compiled-embedding-load.ts with a fresh path and the same
Bun target (see compiled-embedding-load.md); require a normalized 384-dimensional
vector on both architectures, using Rosetta for x64. It compiles a production
embedding fixture with the release flags; do not claim it is an inference through
the exact CLI candidate. Retain its result alongside the CLI evidence.

Supply VERIFY_NODE, NODE_PATH and VERIFY_BROWSER to the parent helper to run
release-candidate-web.mjs before daemon cleanup. It screenshots actual /neo with
the browser's HOME and TMPDIR inside the same disposable isolated run and
the published answer and the life-admin session transcript at 1280×900. The command helper
proves compiled entrypoints, RPC and SDK paths.
If binding is denied, preserve the exact error and report blocked; never work around
that restriction. Save evidence outside the disposable data, then remove only the
owned HOME/data/tmp after all owned processes are stopped. Report every unverified
or failed step to the release coordinator; human approval is required before publish.

## Standalone server and macOS desktop

Run `bun scripts/smoke-test.ts "$DAEMON" --daemon` against the exact-commit
standalone daemon for each macOS architecture. It starts its own isolated
test server and uses an ephemeral port.

Build the release-mode macOS bundle with the same candidate's CLI as its sidecar,
or take the bundle from the exact-commit release dry run. Check the app version
in `Contents/Info.plist` and the bundled `Contents/MacOS/hyperneo --version`.
Launch the bundle executable directly from the build directory with a scrubbed
environment and fresh `HOME`, `TMPDIR`, `HYPERNEO_DATA_DIR` and
`HYPERNEO_DESKTOP_WORKSPACE`. Set `NODE_ENV=test` and
`HYPERNEO_DESKTOP_PORT` to a checked free loopback port other than 8399.

Confirm the app spawns its bundled daemon, the isolated daemon reports the
candidate commit through `system.build`, and the native window reaches the
HyperNeo UI. Capture the window and check its contents. Quit the test app and
verify its sidecar has stopped and the port no longer responds before removing
the temporary data.
