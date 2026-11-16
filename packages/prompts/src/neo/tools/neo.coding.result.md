---
id: neo.coding.result
---
Record Review or Verify evidence for the exact persisted coding assignment (legacy qa remains accepted). Requires its todo, worker ref, actor identity, PR head and acceptance-contract reference; rejects stale heads, mismatches and attempts to erase a failure. The stored Review verdict is posted once to the PR as a labelled comment naming the reviewer model, harness and head. Bot approval is read from GitHub, never submitted through this operation.
