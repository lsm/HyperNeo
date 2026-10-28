# Pin and extract the shared conversation INSERT

This is a verbatim extraction, with no old product behavior to break. Commit the
passing characterization before extraction; do not present it as a bug fix.
The unchanged conversation-reservation-extract.test.ts drives both real callers
and compares the old SQL bytes, bound arguments, SQLite result, first stored row
and rollback. Freeze the clock so core's Date.now() differs from reset's explicit
time. Cover no binding, existing row/ignored insert and both sites under one reset
transaction. This pins actual storage behavior, not a mocked helper.

Run lane-c-conversation-reservation-extract.ts through proof-run.sh before and
after extraction with Bun, then the installed Deno via VERIFY_PROOF_RUNTIME=deno.
The wrapper selects the conversation-reservation mode of the existing reset
command proof. It uses disposable HOME/data, no keys, a refusing gh stub, owned
loopback listeners and real CLI/public readers. Never use the live daemon or
port 8399. The synthetic fixture clears only its conversation reservation while
retaining a valid default binding: the command must recreate that same ID, keep
the core timestamp, and roll it back with a failed second notice. Both callers
run in the same native worker transaction. All existing reset invariants and
cached/new target SQL denial on main remain required. Save numeric metrics and
flags only; proof-run saves evidence and immediately removes synthetic data.
Record actual Bun 1.4.3 and Deno 2.9.4; this local Bun proof does not establish
pinned Bun 1.4.2 native coverage. Browser layout/deployment remain unverified.

Remeasure with lane-c-conversation-reservation-extract-measure.cjs. It pins the
reservation SQL hash and counts its two old sites versus one extracted site.
The standalone extraction removes prepare 1 / run 1. The later receipt SELECT
will make the combined sequence net prepare 0 / run -1; do not raise or edit the
baseline. Reuse the separately audited 277-line core append subtree contract.
Run lane-c-conversation-reservation-compare.cjs after preserving before/after JSON.
It requires identical semantic evidence on each runtime and identical SQL hashes,
while retaining timing/memory measurements separately. Run the focused strict
checker and pairing/core Neo repository tests.

Before opening, list every open PR and its files read-only through GitHub REST.
The coordinator explicitly permits the existing NeoRepository draft overlap to
rebase after this extraction. A different overlap needs routing before opening.
No draft branch, publication/service, app or WorkerLane changes belong here.
