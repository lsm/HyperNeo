# Manual merge local-state admission on the DB gateway

Use shared isolation and the resource guard in SKILL.md; run heavy jobs serially.

```sh
python3 .claude/skills/verify/lane-a-merge-local-db-run.py bun before
python3 .claude/skills/verify/lane-a-merge-local-db-run.py bun verify
python3 .claude/skills/verify/lane-a-merge-local-db-run.py deno verify --executable "$DENO"
```

DENO names an existing runtime with cached imports. Every run owns a fresh
synthetic HOME/data/TMPDIR, real daemon and ephemeral non-8399 listener. The gh
fixture answers only synthetic PR/review/check/thread reads and logs calls;
external HTTP is refused. No credentials, live daemon/data, model or GUI is used.
The runner retains evidence and removes temporary daemon data after shutdown.
Before mode temporarily restores the old merge files from origin/dev and restores
the draft in finally; do not edit concurrently. Commit the failing real RPC
regression before production changes.

The real neo.coding.merge.prepare operation refuses missing verification,
non-current review, pending/failing CI, unresolved threads, missing sign-off and
a changed final head. With full evidence it returns the exact SHA-pinned manual
command, records a receipt and leaves the todo doing. It never executes a merge.
A compatible receipt survives restart and reuse; a conflicting immutable receipt
is refused. Competing receipt jobs retain one winner and full Unicode evidence.

Pause the final receipt command after the GitHub head and local-state recheck,
then close the synthetic todo. The writer must refuse admission and persist no
receipt. Restoring the todo permits a new attempt. The baseline admits this stale
request and fails the observable regression. Local author, assignment, stage,
policy and linked-todo facts are read in one gateway snapshot and compared again
inside the receipt transaction. No transaction spans the GitHub reads.

Main instrumentation covers local admission tables and receipt SQL during merge
RPCs, excluding fixtures and assertion queries. Fixed runs require zero target
SQL on main; before mode requires target SQL. This is not whole-daemon SQL absence,
a latency result, actual GitHub transport, a native actor run or a real merge.
Gateway duration and argument/reply sizes do not separately attribute SQL, queue
or cloning costs. Retain failed attempts as failures rather than partial passes.

Bind both successful runtime runs to the committed application/helper tree:

```sh
bun --no-install --no-env-file .claude/skills/verify/lane-a-merge-local-proof-binding.ts HEAD
```

Only this journey and its evidence directory may change after the bound proof
commit. Source, test or helper changes require new committed runtime proofs.

The CI-discovered writer suite also snapshots through the gateway, closes the
todo, and requires a refused receipt with no stored row under guarded and
read-only main connections. Restoring the todo must permit the original snapshot
again. Both new tests fail if the stale-state comparison is temporarily removed;
ci-cas-mutation.txt records that sensitivity check with production restored.

```sh
(cd packages/daemon && bunx vitest run tests/unit/1-core/operations/coding-merge-receipt-writer.test.ts)
```

The merge operation no longer injects an unused main-thread ledger instance.
Before mode restores the matching runtime construction as well as the old merge
files, so that historical comparison retains the old dependency contract.
