# Manual merge receipt validation on the DB writer

Follow shared isolation and the resource guard in SKILL.md. Reuse the existing
checkout and installed runtimes, with one heavy job at a time.

```sh
python3 .claude/skills/verify/coding-merge-receipt-db-run.py bun before
python3 .claude/skills/verify/coding-merge-receipt-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/coding-merge-receipt-db-run.py bun verify
python3 .claude/skills/verify/coding-merge-receipt-db-run.py deno verify --executable "$DENO"
bun --no-install --no-env-file .claude/skills/verify/coding-merge-receipt-proof-binding.ts HEAD
```

DENO names an existing runtime. Imports are cached-only. The runner refuses
insufficient memory or disk, creates a fresh synthetic HOME/data/TMPDIR, saves
evidence and immediately removes temporary daemon data. Before mode restores
only merge-gates.ts and delivery-facts.ts from origin/dev, restoring the draft
in finally; never edit or run another job concurrently. The failing bound-writer
regression is committed before the implementation.

The proof owns a real daemon and public WebSocket operation.invoke connection
on an ephemeral non-8399 port. A local gh fixture supplies only synthetic PR
reads, reviews, checks and threads; it refuses unknown commands. The fixture
uses an existing Bun executable even when the daemon runs on Deno. Direct HTTP
throws. No credentials, live database, installed Desktop, model or browser is
involved. No real merge, actor dispatch or deployment is attempted.

Production neo.coding.merge.prepare must refuse missing Verify, pending/failing
CI, stale or negative bot review, unresolved findings, applicable absent human
sign-off and a changed final head. Only the passing case commits the matching
receipt and returns its exact SHA-pinned manual command. A compatible retry and
reopened daemon retain that receipt. A conflicting immutable QA assignment must
refuse and preserve the stored receipt; the todo remains doing.

A persisted synthetic daemon job then invokes the production merge-gate pipeline
with two distinct QA assignments competing for one todo/PR/head. Exactly one
receipt succeeds, the other returns merge_receipt_changed. The winning receipt
preserves the complete large Unicode evidence string through the worker boundary.
The job is a synthetic concurrency harness, not a second public merge API.

Main SQL instrumentation covers pack_coding_delivery_facts during merge-prepare
RPCs and the race job. Fixture and assertion SQL is excluded. Baseline requires
receipt reads on main; fixed runs require zero target SQL. Recording, immutable
receipt validation and the boolean result share one writer transaction. A
pinned command is returned only after that transaction commits. Existing
read-only GitHub acquisition stays outside the transaction.

Other merge-operation local-state reads and smoke admission are not covered by
this slice. No whole-daemon SQL absence, GUI, rollout or latency claim is made.
Gateway duration and argument/reply bytes are retained without separate SQL,
queue and clone attribution. Focused suites retain historical heads, evidence
updates, assignment conflicts and smoke behavior, alongside full checks.

The binding audit pins one committed application and helper tree to both runtime
proofs and checks successful cleanup receipts. Only this journey and its evidence
folder may change afterward. Any source, test or helper change requires a new
committed proof head and fresh runtime proofs.
