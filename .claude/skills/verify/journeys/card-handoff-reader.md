# Source-bound worker handoff reader

Run `proof-run.sh` with `card-handoff-read.ts` from a fresh checkout. The helper
starts an isolated daemon, publishes a synthetic HTML handoff through the worker
MCP operation, and seeds its path-free reference on a synthetic question and
publication. It reads both through the paired local-user RPC door, verifies HTML
sanitization and the absence of internal paths, and checks forged references,
missing sources, and tampering. It closes the daemon and removes its temporary
data. Focused `card-handoff-read.test.ts` additionally exercises Markdown, foreign
owners, worker denial, source removal during a read and version-bound chunks.

This slice seeds the stored reference directly because publication and question
writers do not yet accept handoff references. It does not prove card writing or
a web or phone preview; those require later integration and separate proof.
