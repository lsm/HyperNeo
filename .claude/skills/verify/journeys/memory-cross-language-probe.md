# Memory search crosses Chinese and English with the real embedder

Run before changing the embedding model or the vector gates in
`agent-memory-repository.ts`. It downloads the real model (about 280 MB), so run
it on a build host, not a laptop:

```bash
MEMORY_PROBE_CACHE=/absolute/cache-dir bun scripts/probe-agent-memory-cross-language.ts
```

It writes three English and three Chinese memories to an in-memory DB through the
real repository and embedder, then searches. A nonzero exit blocks the change.

- `ranks intended memories first both ways`: each Chinese query must return its
  English memory first, and each English query its Chinese memory.
- `returns no unrelated hits`: off-topic queries in both languages return nothing.
- `recovered runtime matches the transformers runtime`: the fallback ONNX path
  must produce the same vector (cosine above 0.999).

Each line prints the top three cosines. Use them to retune the admission
threshold (between the best unrelated and the worst relevant top cosine) and the
top-relative delta. Keep the full output for the PR.
