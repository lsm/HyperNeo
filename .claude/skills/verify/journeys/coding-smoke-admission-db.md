# Coding smoke admission on the DB writer

Use shared isolation and the resource guard in SKILL.md. Reuse the existing
checkout and installed runtimes; run each heavy job serially.

```sh
python3 .claude/skills/verify/coding-smoke-admission-db-run.py bun before
python3 .claude/skills/verify/coding-smoke-admission-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/coding-smoke-admission-db-run.py bun verify
python3 .claude/skills/verify/coding-smoke-admission-db-run.py deno verify --executable "$DENO"
bun --no-install --no-env-file .claude/skills/verify/coding-smoke-admission-proof-binding.ts HEAD
```

DENO names an existing runtime. Imports are cached-only. Every run owns a fresh
synthetic HOME/data/TMPDIR and real daemon on an ephemeral non-8399 port. The
runner saves evidence before immediately deleting temporary daemon data. Before
mode restores smoke-operation.ts and delivery-facts.ts from origin/dev and
restores the draft in finally; never edit or run another job concurrently.
The bound-writer regression must fail and be committed before implementation.

The helper calls the actual neo.coding.smoke WebSocket operation. A local gh
fixture permits only synthetic merged-PR reads and build-ancestry comparisons;
other commands and direct HTTP are refused. QA assignments and the merge receipt
are synthetic fixtures. No keys, live database, model, browser or deployment are
used. The local source build identity is used only to exercise the production
containment check; evidence records no host identity.

Pass: the assigned independent QA actor can record passing, failing and explicitly
inapplicable smoke. Wrong actors, mismatched merge commits, absent containing
builds and missing inapplicability reasons are refused. An unassigned actor must
be refused before external deployment reads. Full Unicode evidence survives the
writer boundary and a failed verdict remains durable after reopening the daemon.
A later valid record remains possible, preserving existing evidence-update rules.

Verify mode pauses a request after deployment acquisition but before its writer
command. Removing its QA assignment must refuse with stage_assignment_mismatch
and preserve prior evidence. In a second queued request, removing the merge
receipt must refuse with matching_merge_gate_required and leave no smoke row.
These fixture changes occur outside the measurement window; no transaction waits
for a callback or external effect.

The advisory preflight is one reader snapshot of the assignment and merge receipt.
The authoritative writer command repeats that check, validates the independent
actor, matching merged head and observed build, and applies the existing exact
receipt update in the same transaction. Pack-level recordSmoke uses the same
synchronous admission pipeline on the writer. External deployment reads remain
outside transactions; replies follow commit. Immutable merge-assignment
one-winner behavior remains covered by the merge-gate regression suite.

Main instrumentation covers pack_facts and pack_coding_delivery_facts during
smoke RPCs. Fixtures and assertions are excluded. Baseline requires target SQL;
fixed runs require zero. Gateway duration and argument/reply bytes are retained
without separate clone, queue and SQL attribution. This is not whole-daemon SQL
absence, a latency result, actual deployment smoke or GUI verification.

Run the new writer test, delivery, delivery-completion and merge-gate suites in
Bun and the CI runner, plus full checks. Bind both successful runtime proofs to
one committed application/helper tree. After that commit only this journey and
its evidence folder may change; any source, test or helper change needs fresh
committed proofs. The delivery-gates journey points to this current operation
proof and retains its historical storage contract context.
