# Missing embedding assets recover for this platform

Use the shared in-process setup in SKILL.md, with pinned Bun 1.4.2 and
`PROOF=.claude/skills/verify/embedding-assets.ts`. No provider, model API mock or
GUI is needed; this journey downloads public embedding assets. Use a fresh
synthetic HOME/data directory on each supported test machine, never a live DB
or checkout. The helper owns its ephemeral non-8399 daemon and closes it in
finally.

The default `recover` mode temporarily hides only this test worktree's installed
binding if one exists, restoring it in finally. It never modifies the shared
package cache or another checkout. Repeat with `fault` after the run directory
to feed checksum-invalid bytes to the real worker: ten requests must fail but
only one download and one `Embeddings unavailable` warning may be observed.
It then advances only the isolated daemon's parent clock by 31 seconds and
makes five further requests: exactly one new attempt is allowed, while the
same failure must not emit another warning. The real worker clock stays intact.
Use `installed` on arm64 as a healthy-runtime control; it must not fetch a
runtime and its vector should agree with the recovered-runtime case.

Run on darwin-x64 and darwin-arm64. The Intel baseline fails with the missing
`../bin/napi-v6/darwin/x64/onnxruntime_binding.node` error. The required end state
is a normalized 384-dimensional vector and a semantic-only `work.find` match
through the real daemon RPC door, without manually installing runtime/model
files. Retain `evidence/embedding-assets.json` and the complete run log, including
fetch/checksum diagnostics and any failed or inconclusive result.

Recovery uses published ONNX Runtime 1.22.0 CPU bindings for Intel macOS, where
upstream stopped publishing native builds in the 1.23 series. Other supported
platforms use the pinned 1.24.3 package. Both packages and the fixed model
assets are verified before use; no installed package is patched by production.
