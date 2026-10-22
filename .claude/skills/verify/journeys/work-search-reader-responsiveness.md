# Work search stays responsive during vector storage waits

Use SKILL.md's in-process RPC setup with
`PROOF=.claude/skills/verify/work-search-reader.ts`. There is no provider turn
or HTTP mock; omit the 8000/8001 preflight. The helper owns an ephemeral daemon,
empty test HOME/data/DB and a refusing GitHub stub. No real DB or keys are used.

Run once with the default 1200 ms modeled storage wait, then in another fresh
directory pass `0` after the run directory for the ordinary-data control. Both
invoke the real `work.find` operation with only the HyperNeo adapter and seed
10,020 complete synthetic indexed messages and 384-dimensional vectors.
Embedding is deterministic; no model download or external adapter is contacted.

The fault fixture delays the first vector statement on whichever thread executes
it, then executes the real SQLite read and ranking unchanged. Its worker entry
imports the real production worker with the same wait instrumentation. It is a
deterministic storage-wait responsiveness regression, not a reproduction or
attribution of the live 4.3-second physical storage delay. Natural probes on
50,000 file-backed rows were 24–29 ms and did not reproduce that delay.

End state: semantic search returns the retained session, all indexed row/body/
embedding hashes are identical, maximum main heartbeat lag is below one second,
and a separate process's actual health RPC stays below 250 ms while the read is
waiting. The delayed search RPC itself intentionally exceeds 250 ms; this is not
a hot-query latency pass. The no-delay control separately requires SQL and the
public search RPC below 250 ms. Save `evidence/observed.json` and
`vector-reads.jsonl`, including failed or inconclusive results.

Before the fix, the wait runs on main and the responsiveness assertions fail.
Commit that failing proof before production edits. After the fix, one persistent
reader serves SDK and work-search commands; errors reject without main-thread
disk fallback. The supported no-disk `:memory:` configuration remains explicit.
The helper closes its probe, WebSocket and daemon in finally. Browser rendering,
real embedding quality, physical I/O bounds and deployed performance are separate.

Measured on the committed fix with pinned Bun1.4.2: the delayed case had
5.99 ms main lag and 0.48 ms independent health latency, versus 1232/1239 ms
on the tests-first source. The no-delay control took 58.86 ms at the public
RPC and 14.07 ms for the largest vector SQL read. The delayed RPC still took
1265 ms. All 10,020 indexed bodies/embeddings hash to
`3ce3df87dac94246be56038cdeb31538cdada8cdbec0e051bcc289a358ae501c`
before and after. Ranking, hit counts, scores and semantic snippets are compared
to the existing repository result within each run, not just session presence.
