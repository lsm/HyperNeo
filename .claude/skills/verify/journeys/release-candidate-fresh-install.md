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
Real SDK download uses public npm. Pairing codes and client credentials stay in memory.

steps.json and daemon.log must show installation version/hash, healthy exact-commit
system.build, first-start SDK download, compiled pair producing an approved code,
a real client claiming it and appearing in compiled devices, a Neo chat input whose
real downloaded SDK publishes the scripted visible reply, and work.start creating
a life-admin session which gets an assistant response. The model is scripted; this
is transport/publication proof, not a test of generative model judgment.

Embedding inference is a separate sequential job because test mode skips eager
embedding warmup. Run compiled-embedding-load.ts with a fresh path and the same
Bun target (see compiled-embedding-load.md); require a normalized 384-dimensional
vector on both architectures, using Rosetta for x64. It compiles a production
embedding fixture with the release flags; do not claim it is an inference through
the exact CLI candidate. Retain its result alongside the CLI evidence.

Supply VERIFY_NODE, NODE_PATH and VERIFY_BROWSER to the parent helper to run
release-candidate-web.mjs before daemon cleanup. It screenshots actual /neo with
the published answer and the life-admin session transcript at 1280×900. The command helper
itself proves compiled entrypoints/RPC/SDK paths, not native iOS or Desktop rendering.
If binding is denied, preserve the exact error and report blocked; never work around
that restriction. Save evidence outside the disposable data, then remove only the
owned HOME/data/tmp after all owned processes are stopped. Report every unverified
or failed step to the release coordinator; human approval is required before publish.
