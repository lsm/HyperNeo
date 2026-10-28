# Build artifact identity writer and committed-identity seam

Use proof-run.sh with lane-c-artifact-identity-command.ts on Bun and native cached
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup checks resources, scrubs credentials,
creates fresh HOME/data and ephemeral listeners, saves evidence and removes data.
No provider/model, credential, GitHub, live daemon or filesystem capture is used.
This construction calls a registered native writer and reads the retained UUID/count;
public artifact callers remain unchanged until the separate activation rungs.

Commit failing command/candidate/seam contracts first. Self-check cached/new main
SQL traps, then refuse identity INSERT and the helper's receipt SELECT on main.
Require pass=true/mainSqlAttempts=0. Four concurrent candidates must return one
retained UUID and one singleton; later candidates retain it. Construct a repository
from that committed receipt without any identity SQL. Hold a competing WAL writer
for 1.2 seconds: command receipt waits and health stays responsive. The deliberate
lock wait is not a sub-250-ms write pass. Admission failure preserves the identity;
a lost committed reply retains the error and never automatically replays.

After asserting the synthetic artifact registry is empty, reset only this owned
fixture's identity row to exercise fresh initialization failure. An AFTER INSERT
trigger records an effect and removes the receipt row: helper lookup fails, so both
creation and trigger effects must roll back. Restore the previously retained UUID
only through the command. Record that explicit fixture reset, separately from the
zero main INSERT/receipt-SELECT target count. No production deletion API is added.

Unit contracts also throw directly during receipt lookup, lose an initial commit
reply, and preserve default helper/constructor behavior. Rerun the prior extraction
contracts: the default UUID is still generated after preparing the INSERT, and the
unchanged synchronous legacy path keeps its caller-owned transaction semantics.
The known-identity constructor path trusts only its caller's committed receipt;
it performs no extra validation, initialization or SQL.

Run the focused strict checker, SQL/constructor/gateway suites, graph/diff measurement
and repository checks. Save payload sizes, timing, loop lag, RSS/WAL and SQL hashes
without UUIDs. Append only this command's op import/array entry and Deno smoke line.
Close owned socket, locks, processors and app before data cleanup. Public activation,
full FS/capture/ownership graph, native Bun 1.4.2 when another Bun is installed,
browser and Neo-owned deployment smoke remain unverified by this construction.
