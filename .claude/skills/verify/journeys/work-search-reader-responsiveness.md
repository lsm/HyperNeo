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

Pinned Bun1.4.2 ordinary controls take 55.81 ms RPC / 13.21 ms SQL natively
and 70.51 / 18.46 ms through IPC. The modeled-wait case retains a 1262 ms RPC,
4.60 ms main lag and 0.37 ms independent health. Full retained SHA is
`3ce3df87dac94246be56038cdeb31538cdada8cdbec0e051bcc289a358ae501c`.

For the Node-hosted online-test boundary, add `0 bridge` after a fresh run
directory. This runs the same public search via the existing isolated IPC host
and a real native Bun worker. Typed arrays are not preserved by its JSON IPC;
the tests-first request lost its vector length and returned no semantic match.
The request DTO must carry numeric arrays and reconstruct the query vector in
the worker. Require the same semantic snippets/ranking and retained hash.

The bridge regression is committed before its DTO fix: semantic work.find
returned no match when the typed array became an object. The fixed bridge and
native controls both return the expected match/snippets with the same complete
retained hash; the fixture symlinks its own Bun binary into its refusing stub
PATH so its IPC host uses the same pinned runtime as the daemon.

For contention pass `1200 native priority` (or `1200 bridge priority`) after
a fresh run directory. Two distinct real searches each wait 1200 ms. Status
and page RPCs must finish before 1800 ms from the first search, ahead of the
second search's wait. The FIFO baseline takes 2477 ms; priority takes 1267/1273 ms.
Three search slots have separate admission from all 16 SDK slots; queued SDK reads
run first. An active SQLite call remains uninterruptible and its timeout fails
the shared generation: this does not prove SDK latency below 250 ms during it.

For adapter fan-out pass `1200 native fanout` (or `1200 bridge fanout`). The
helper creates only synthetic Codex state and Claude project directories in its
empty HOME, activating the three search families. One work.find must return the
retained HyperNeo and Claude semantic matches with no unreachable adapter, and
all 10,021 complete indexed bodies/embeddings must retain their hash. The two-slot
baseline drops claude-code as queue-full; three slots admit this normal fan-out.

For rejection recovery pass `1200 native recovery` (or `1200 bridge recovery`).
A three-family search fills admission; another text is rejected. After the first
drains, retry that same rejected text within the two-second reuse interval.
Require no unreachable adapter and both retained matches, with unchanged stored
hash. The baseline reuses the rejected promise; failed-entry eviction recovers.
