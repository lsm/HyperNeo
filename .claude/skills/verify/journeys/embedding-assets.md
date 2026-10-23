# Missing embedding assets recover for this platform

Use the shared in-process setup in SKILL.md, with pinned Bun 1.4.2 and
`PROOF=.claude/skills/verify/embedding-assets.ts`. No provider, model API mock or
GUI is needed; this journey downloads public embedding assets. Use a fresh
synthetic HOME/data directory on each supported test machine, never a live DB
or checkout. The helper owns its ephemeral non-8399 daemon and closes it in
finally.

Run on darwin-x64 and darwin-arm64. The Intel baseline fails with the missing
`../bin/napi-v6/darwin/x64/onnxruntime_binding.node` error. The required end state
is a normalized 384-dimensional vector and a semantic-only `work.find` match
through the real daemon RPC door, without manually installing runtime/model
files. Retain `evidence/embedding-assets.json` and the complete run log, including
fetch/checksum diagnostics and any failed or inconclusive result.
