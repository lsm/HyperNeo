# Neo-owned agent memory

Design, 2026-11-27. Based on [research](../research/agent-memory-findings.md); no new subsystem.

## Ownership

- Keep one human-scoped store in Neo core. Re-home the existing `AgentMemoryRepository`
  from Space ownership; add no service layer and no per-worker stores.
- Expose `memory.save`, `memory.search`, `memory.read` and `memory.delete` as ordinary
  `defineOperation` paths. On both operations MCP and `operation.invoke` RPC, admission
  requires Neo for all four and the human UI for search/read; workers are denied all four.
  Neo alone decides whether a learning is worth saving, updating or deleting.
- A worker reports learning in its ordinary result to Neo. Dispatch reads under Neo's
  authority and puts only selected memories in its brief, with no worker memory tools.

## Search that works for real queries

- Retain hybrid retrieval: trigram FTS with bm25, embeddings, then reciprocal rank fusion.
  Search is read-only; a hit no longer increments `access_count`.
- FTS uses any-word matching: join terms with `OR`, not `AND`. Split whitespace-delimited
  languages normally and Chinese runs into overlapping three-character terms; bm25 ranks
  the combined matches, so an extra natural-language word cannot suppress a good memory.
- Replace the English embedder with multilingual `intfloat/multilingual-e5-small` (candidate).
  It ships only if the existing cross-language probe ranks the intended memory first for all
  six queries covering both directions and unrelated-query controls return no hits. Failure
  selects another multilingual candidate; silently retaining the English model is not a fallback.
- Before RRF, reject the whole vector arm when its top cosine is below a probe-calibrated
  absolute admission threshold; then keep hits within a tuned delta (start at 0.05) of that top.
  The probe tunes both gates with relevant, below-floor and wholly unrelated fixtures.
  Exact identifiers remain protected by FTS; cross-language meaning comes from vectors.

## Retrieval without guessing

- Extend the existing `neo-plan-hook` `UserPromptSubmit` path. Search with the human's
  submitted message verbatim and inject the top three hits above the floor into
  `additionalContext`; Neo never invents keywords.
- At worker dispatch, run exactly one search with the full todo text and put its top three
  hits in the worker start brief. Workers get no separate lookup operation or search tool.

## Slice order

1. **Hook plus any-word FTS, the smallest first slice.** Re-home the store behind operations;
   inject FTS-only results and leave the vector arm disabled until slice 2. Start with failing
   `neo-plan-hook.test.ts` cases `"injects top three FTS memories for the human message"` and
   `"injects no memories for an unrelated query"`;
   `agent-memory-repository.test.ts: "matches any term and segments Chinese trigrams"`; and
   `agent-memory-operations.test.ts: "denies every memory operation to workers and allows Neo"`.
2. **Multilingual vectors and relevance gates.** Start with failing cross-language probe
   assertions `"ranks the intended memory first in both language directions"` and
   `"returns no hits for unrelated queries"`, plus
   `agent-memory-repository.test.ts: "excludes vector hits below the top-relative floor"`.
3. **Worker brief injection.** Start with failing
   `neo-todo-runner.test.ts: "adds one todo-text memory lookup to a new worker brief"`;
   assert one lookup and no worker memory tools, then wire dispatch.

## Unsupported now; rejected alternative

No related-memories operation, automatic learning extraction, legacy Space-row migration or
worker memory API. Spaces stay parked: no flag, runtime or UI. Rejected: direct worker
`memory.search`, which recreates query guessing and harness-dependent retrieval.
