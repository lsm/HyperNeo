# Publication revision admission on the DB writer

Use the shared isolation and resource guard in SKILL.md. Reuse the existing
checkout and installed runtimes; run each heavy job serially.

```sh
python3 .claude/skills/verify/neo-publication-edit-db-run.py bun before
python3 .claude/skills/verify/neo-publication-edit-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/neo-publication-edit-db-run.py bun verify
python3 .claude/skills/verify/neo-publication-edit-db-run.py deno verify --executable "$DENO"
bun --no-install --no-env-file .claude/skills/verify/neo-publication-edit-proof-binding.ts HEAD
```

DENO identifies an existing runtime and imports are cached-only. The runner
refuses memory below 25% or disk below 25 GiB. Every run owns a fresh synthetic
HOME/data/TMPDIR and SQLite database. A real daemon binds an ephemeral port,
refuses 8399, blocks real HTTP and supplies a gh stub refusing all requests.
No credentials, live database, native Desktop, model turn or browser is used.
Evidence is saved before immediately deleting temporary daemon data.

Before mode temporarily restores publication-change-operation.ts and
neo-publication-repository.ts from origin/dev, then restores the draft in
finally. Do not edit or run another proof concurrently. A failing observable
bound-writer regression is committed before the fix; baseline mode must record
admission SQL on the daemon main connection.

The proof invokes the daemon's actually registered neo.publication.edit through
its production MCP handler and reads the result over the public WebSocket
neo.publication.read RPC. This covers agent revision receipts and public message
content, not rendered GUI appearance. The existing admission pipeline runs
synchronously inside the gateway's writer transaction, including binding,
lifetime, conversation, revision-identity and current-message checks. Main only
announces accepted results after that transaction returns. No separate awaited
reader call splits admission from mutation. Card-reply append is unchanged.

Pass: repeated revision identity is idempotent even after a later revision;
conflicting text or reuse on another publication is refused. Original publish
retry returns its existing receipt without reverting the revised message;
changed original content conflicts. Foreign publication IDs, unbound producers
and shortText on verbatim replies are refused. Two competing revisions with one
request identity have exactly one winner. History and exact Unicode fullText
survive the worker/MCP boundary, public read and daemon reopen.

Verify mode pauses the command before dispatch, removes the caller binding in
the synthetic fixture, then releases it. Worker admission must refuse the stale
caller and leave public content unchanged. Fixture mutations and public reader
SQL are excluded from edit-path instrumentation; verify mode requires zero main
SQL for publication/binding access during edit. No whole-daemon or public-reader
SQL absence, latency target or rollout claim is made. Command elapsed times and
argument/reply sizes are retained without separate clone/queue/SQL attribution.

Run writer regression, existing publication edit and repository suites in the
CI runner plus full checks. The evidence binding identifies one committed
application tree for both fixed runtime proofs. After that commit only this
journey and its evidence folder may change. The audit checks ancestry, source
and helper blobs, successful run receipts and all post-proof edits. Any source,
test or helper edit requires a new committed proof head and fresh Bun/Deno runs.
