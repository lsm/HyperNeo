# Compiled binaries load embeddings in a fresh data dir

Release binaries download and extract the ONNX Runtime packages at run time
(`embeddingRuntime` in `embedding-assets.ts`). `onnxruntime-node` then requires
`onnxruntime-common`, whose `main` is `dist/cjs/index.js`. A Bun standalone
executable only reads that `package.json` when it is compiled with
`--compile-autoload-package-json`, so every compile command carries the flag
through `compileArgs` in `scripts/compiled-worker-entrypoints.ts` (the workflow
commands spell it out).

Run from the repo root with a fresh run directory; it needs network access to
npm and the `embedding-models-v1` GitHub release. No daemon, provider or GUI is
used:

```bash
bun .claude/skills/verify/compiled-embedding-load.ts /private/tmp/hn-embedding-load-UNIQUE
bun .claude/skills/verify/compiled-embedding-load.ts /private/tmp/hn-embedding-load-x64-UNIQUE bun-darwin-x64
```

The helper compiles `packages/daemon/tests/unit/lib/compiled-embedding-fixture.ts`
with the release compile arguments for the target (default: this machine;
`bun-darwin-x64` runs under Rosetta on Apple silicon), runs it with a fresh
HOME and `HYPERNEO_DATA_DIR`, `NODE_ENV=test` and a minimal environment, and
requires a normalized 384-dimensional vector. Without the flag it fails with
`Cannot find package 'onnxruntime-common'`, the v0.48.0 symptom. Evidence:
`$RUN/evidence/compiled-embedding-load.json`. CI runs it on Windows for pull
requests and on linux-x64 for pushes to dev.

It proves the runtime and model load in a compiled binary. The daemon only
warms embeddings outside `NODE_ENV=test`, so a whole-daemon semantic search in
a compiled binary is not part of this journey. For daemon startup and worker
loading with the same flags, follow the compiled worker startup check
(`compiled-worker-startup.ts`).
