# Discover the newest Codex state database

Use SKILL.md's metadata-only wrapper; no model, native application or fixed HTTP
port is needed. Run the modes sequentially with distinct evidence directories:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/codex-state-discovery.ts six-only
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/another-evidence-directory .claude/skills/verify/codex-state-discovery.ts
```

Add `unavailable-home` after the helper path to seed a regular file where the
Codex directory would be. Startup must succeed and work.find must return an
ordinary empty result. Unit coverage also injects an EACCES directory read.
The helper asserts that worktrees are disabled in its effective config before
starting the daemon.

The helper owns a fresh daemon and synthetic HOME/data/DB. In six-only mode,
only state_6.sqlite exists. In the default mode, state_5, state_6 and state_10
coexist with an unrelated sidecar and a directory named like a later database.
Real work.find RPC must return only the highest numbered database's worker.
Hashing the selected database before and after discovery verifies that reads
leave its contents untouched.

Remove a required table, then a required column, only from the synthetic newest
database. Each find must expose codex-desktop in unreachable with an explicit
unsupported-schema reason naming the missing object. It must never fall back to
the older database or report a successful empty result. Restore the schema and
verify discovery recovers on the same reader.

Keep receipts.json, observed.json, proof.log, run-status.json and cleanup.json.
The helper closes its daemon; the wrapper saves evidence and removes temporary
data. This proves discovery through RPC, not GUI rendering or a real installed
Codex version upgrade. A separately authorized post-deploy laptop check is still
required before claiming that deployment works.
