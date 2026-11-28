# Neo-owned agent memory

Design, 2026-11-27. Implements the direction in
[agent-memory research](../research/agent-memory-findings.md), not a new memory subsystem.

## Ownership

- Keep one human-scoped store in Neo core. Re-home the existing `AgentMemoryRepository`
  from Space ownership; add no service layer and no per-worker stores.
- Expose `memory.save`, `memory.search`, `memory.read` and `memory.delete` as ordinary
  `defineOperation` paths. Neo uses operations MCP; the web UI uses `operation.invoke`.
- Neo is the only writer. Mutation operations reject worker callers; workers receive no
  memory-write tools. Neo decides whether a learning is worth saving, updating or deleting.
- A worker reports learning in its ordinary result to Neo. Its task brief contains relevant
  memories, so every harness gets the same context without a memory-specific integration.

## Search that works for real queries

- Retain hybrid retrieval: trigram FTS with bm25, embeddings, then reciprocal rank fusion.
  Search is read-only; a hit no longer increments `access_count`.
- FTS uses any-word matching: join terms with `OR`, not `AND`. Split whitespace-delimited
  languages normally and Chinese runs into overlapping three-character terms; bm25 ranks
  the combined matches, so an extra natural-language word cannot suppress a good memory.
- Replace the English embedder with a multilingual model. `intfloat/multilingual-e5-small`
  is the candidate, not a foregone choice. It ships only if the existing cross-language
  probe ranks the intended memory first for all six queries covering both language
  directions and its relevance-floor cases pass. Failure selects another multilingual
  candidate; silently retaining the English model is not a fallback.
- Keep vector hits within a tuned delta of the top cosine score (start at 0.05), before RRF.
  The probe tunes that relative floor and supplies passing and below-floor fixtures.
  Exact identifiers remain protected by FTS; cross-language meaning comes from vectors.

## Retrieval without guessing

- Extend the existing `neo-plan-hook` `UserPromptSubmit` path. Search with the human's
  submitted message verbatim and inject the top three hits above the floor into
  `additionalContext`; Neo never invents keywords.
- At worker dispatch, run exactly one search with the full todo text and put its top three
  hits in the worker start brief. Workers get no separate lookup operation or search tool.

## Slice order

1. **Hook plus any-word FTS, the smallest first slice.** Re-home the store behind Neo's
   operations and add prompt injection without vector changes. Start with failing
   `neo-plan-hook.test.ts: "injects the top three memories for the human message"` and
   `agent-memory-repository.test.ts: "matches any term and segments Chinese trigrams"`.
2. **Multilingual vectors and the relative floor.** Start with the failing cross-language
   probe assertion `"ranks the intended memory first in both language directions"` and
   `agent-memory-repository.test.ts: "excludes vector hits below the top-relative floor"`.
3. **Worker brief injection.** Start with failing
   `neo-todo-runner.test.ts: "adds one todo-text memory lookup to a new worker brief"`;
   assert one lookup and no worker memory tools, then wire dispatch.

## Unsupported now; rejected alternative

No related-memories operation, automatic learning extraction, legacy Space-row migration,
or worker memory API. Spaces stay parked: this does not enable its flag, runtime or UI.
Rejected: giving workers direct `memory.search`; it recreates query guessing and produces
harness-dependent retrieval instead of one deterministic brief at dispatch.
