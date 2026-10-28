# Build the workspace history upsert writer command

Run proof-run.sh with lane-c-workspace-upsert.ts on Bun and cached native Deno
(VERIFY_PROOF_RUNTIME=deno). It checks resources, scrubs credentials, uses a fresh
HOME/data and ephemeral listeners, saves evidence and removes synthetic data.
No provider/model, HTTP mock, live daemon, real credential or existing workspace
is needed. Record actual runtimes; local Bun 1.4.3 does not establish native
Bun 1.4.2 coverage.

Commit a failing construction proof first: the native worker rejects the missing
command while the legacy upsert(path) clock/counter contract passes. Add a typed
command accepting only a path and captured numeric time, returning a plain row.
The existing upsert(path) default clock remains. Its SQL and receipt query stay
byte-identical; the query executes inside the same immediate writer transaction.

Self-check cached/new main INSERT and single-path receipt SELECT guards, then deny
them. Execute the registered command through the isolated daemon gateway and
observe real workspace.history RPC readback. Insert yields count 1; repeated and
concurrent commands increment exactly once and return each command's committed
counter/time. Bind quoted/Unicode paths literally. Fail an update and retain the
previous row. Hold another WAL writer for 1.2 seconds: the result must wait for
commit, health stays responsive, and the row retains the caller's captured time
rather than the later worker execution time. The intentional lock wait does not
meet a 250 ms write target; report it separately from uncontended command timing.
Fail before post and lose a committed reply: do not automatically replay a
non-idempotent increment. A later independent command increments once more.

Unit contracts separately throw during receipt lookup after insertion/update and
require both effects to roll back. Pin the default-clock legacy call unchanged.
Run the focused strict checker, workspace/gateway contracts, repository checks and
full local graph/diff measurement. Save flags, byte/timing/RSS/WAL and SQL hashes;
never paths, credentials or raw history contents. Close owned clients, locks,
processors and daemon before the wrapper saves evidence and removes data.

This construction does not call public workspace.add or MCP refresh/import/tool
persistence. Their full dependency audit and main-side filesystem/import/event
contracts belong to the separately authorized wiring PR. No full MCP audit is
claimed here. History reads, public add wiring, browser layout and deployment
remain outside this construction proof.
