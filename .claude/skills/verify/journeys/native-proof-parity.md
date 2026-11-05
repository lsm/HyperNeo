# Pin native proof parity before runtime migration

Use the resource and isolation rules in ../SKILL.md. This slice changes a
read-only repository checker, not the daemon. The verification surface is its
Bun CLI and the root check that CI runs; no daemon, provider, network or live
port is needed.

Run:

Before construction it fails because the checker is unavailable; commit that
failure and its tests first. After construction it must report all 117 ordered
helper commands pinned.

The manifest stores helper identity and each complete logical command: shell
continuations are joined, preserving environment expressions, runtime flags,
arguments and invocation order. Its source hash also protects referenced shell
bindings, directory setup and inline probes that are not helper invocations.
The checker only reads these inputs; it never sources or executes either file.

Use fresh temporary fixture copies with an omitted/duplicated/reordered entry,
changed helper/env/runtime/mode argument, or changed source setup. Each must
exit nonzero. Append a synthetic touch command to the copied source and check
its marker was never created. Retain CLI outputs and exit statuses before
removing the fixtures. Unit tests cover these cases too.

This is a temporary legacy parity baseline for the approved Bun migration.
When a new helper is intentionally added, update its ordered manifest entry and
the source hash in that same PR, after reviewing the runner change. When a
later extraction changes setup, re-audit and update the source hash explicitly.
Do not refresh a hash to bless missing coverage or relabel old runtime evidence.
Retire this legacy binding only after the replacement manifest proves parity.

This verifies inventory preservation, not that any helper has been migrated to Bun; Bun
probe construction and extraction are later PRs.
