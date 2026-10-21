## In-app previews: capture policy (slice 3)

Run `preview-policy.test.ts` with the daemon Vitest runner. It covers each pure
admission gate and their composition, authorization before path classification,
missing/foreign/mismatched bindings, owner/role spoofing, component containment,
explicit evidence roots, traversal/encoding refusals, sensitive names and broad
root denial. It never opens a source file. Root-relative plans must be passed to
the anchored opener in slice 4; a successful policy result is not a safe-open proof.

Repeat slice 1's isolated capture/restart journey and headless Markdown component
suite. The helper now supplies a trusted synthetic context-binding fixture to the
policy pipeline, requires an admitted plan for its published report, and refuses
a sensitive path and a foreign worker. It still checks complete bytes through the
actual existing daemon read door after restart. No production binding adapter or
new operation is wired here: the persisted todo/ask adapter belongs to slice 6.
No credentials or live files are read; no unattended GUI is involved.

For the slice-3 review regression, root-denial tests must put the candidate source
inside each excluded root (workspace and evidence variants), including macOS
`/private/var/tmp` and nested `.claude`/`.codex`/`.config` components. Keep positive
controls for a narrowly approved temporary evidence directory and similarly named
nonsensitive siblings; blocking a broad temp root must not block isolated fixtures.

These names are defense in depth only. This module neither opens files nor
registers a reader. Registration must remain unwired until the anchored descriptor
opener and immutable hash capture exist (slices 4–6). Reads must use authorized
registry receipts, never this plan or a re-resolved path as a grant (slice 7).
