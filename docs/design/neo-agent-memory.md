# Neo-owned agent memory

Design, 2026-11-27. Based on [research](../research/agent-memory-findings.md); no new subsystem.

## Ownership

- Keep one human-scoped store in Neo core. Re-home the existing `AgentMemoryRepository`
  from Space ownership; add no service layer and no per-worker stores.
- Expose `memory.save`, `memory.search`, `memory.read` and `memory.delete` as ordinary
  `defineOperation` paths. Each `execute` checks role/source: Neo via MCP/internal dispatch
  has all four; local-user RPC has search/read; every worker caller is denied all four.
  No shared-gate widening. Neo alone decides whether to save, update or delete a learning.
- A worker reports learning in its ordinary result to Neo. Dispatch reads under Neo's
  authority and puts only selected memories in its brief, with no worker memory tools.

## Search that works for real queries

- Retain hybrid retrieval: trigram FTS/bm25, embeddings and RRF. Search stays read-only.
  Drop daily consolidation, `access_count`, 90-day pruning and core memories; Neo deletes stale entries.
- FTS strips a fixed English stopword list, then joins terms with `OR`; stopword-only
  queries return no hits. Split whitespace languages normally and Chinese runs into
  overlapping trigrams; bm25 ranks matches, so an extra word cannot suppress a good memory.
- Replace the English embedder with multilingual `intfloat/multilingual-e5-small` (candidate).
  It ships only after the probe passes; failure selects another multilingual model, never an English fallback.
- Before RRF, reject the whole vector arm when its top cosine is below a probe-calibrated
  absolute admission threshold; then keep hits within a tuned delta (start at 0.05) of that top.
  The probe tunes both gates with relevant, below-floor and wholly unrelated fixtures.
  Exact identifiers remain protected by FTS; cross-language meaning comes from vectors.

## Retrieval without guessing

- Extend the existing `neo-plan-hook` `UserPromptSubmit` path. Search with the human's
  submitted message verbatim and inject the top three hits surviving the gates into
  `additionalContext`; Neo never invents keywords. The hook also fires for worker reports:
  skip memory search for those worker-sent inputs rather than querying with the report text.
- At worker dispatch, run exactly one search with the full todo text and put its top three
  hits in the worker start brief. Workers get no separate lookup operation or search tool.

## Slice order

1. **Hook plus any-word FTS, the smallest first slice.** Re-home the store behind operations;
   inject FTS-only results and leave the vector arm disabled until slice 2. Start with failing
   `neo-plan-hook.test.ts` cases `"injects top three FTS memories for the human message"`,
   `"skips memory search for worker-sent reports"` and
   `"ignores stopword-only overlap in an unrelated query"`;
   `agent-memory-repository.test.ts: "matches any term and segments Chinese trigrams"`; and
   `agent-memory-operations.test.ts: "allows Neo and denies MCP/RPC workers via invokeOperation"`.
   The live store has 0 rows, so this slice also adds Neo prompt guidance: a learning is a
   durable human preference, decision, environment constraint or reusable lesson that matters
   beyond the current task and is not already recorded in the repo. Save one when Neo learns or
   confirms it; update the existing entry when new information refines or supersedes it; delete
   it when it is wrong, obsolete or withdrawn. Do not save transient task status or worker
   output by default. Keep this slice first because it establishes Neo-owned writes and the
   retrieval path, but do not claim it fixes Chinese "finds nothing": trigram FTS needs three
   characters and most Chinese words have two. Slice 2's multilingual vectors carry that fix.
2. **Multilingual vectors and relevance gates.** Add verified multilingual file/checksum
   manifests replacing Granite's in `agent-memory-transformers.ts` and `embedding-assets.ts`.
   Move the ad hoc probe to `scripts/probe-agent-memory-cross-language.ts` with real-model
   assertions `"ranks intended memories first both ways"` and `"returns no unrelated hits"`;
   nonzero blocks slice-2 merge and its output goes in the PR. Also start failing
   `agent-memory-repository.test.ts: "excludes vector hits below the top-relative floor"`.
3. **Worker brief injection.** Start with failing
   `neo-todo-runner.test.ts: "adds one todo-text memory lookup to a new worker brief"`;
   assert one lookup and no worker memory tools, then wire dispatch.

## Unsupported now; rejected alternative

No related-memories operation, automatic learning extraction, legacy Space-row migration or
worker memory API. Spaces stay parked: no flag, runtime or UI. Rejected: direct worker
`memory.search`, which recreates query guessing and harness-dependent retrieval.
