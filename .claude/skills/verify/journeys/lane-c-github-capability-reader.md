# GitHub capability callback reader activation

Use shared setup in `../SKILL.md` and run `proof-run.sh` with
`lane-c-github-capability-reader.ts` under Bun. The helper owns a fresh synthetic daemon,
authenticated WebSocket, refusing GitHub/HTTP stubs and an ephemeral listener. Stop
processors and finish startup body copying before measuring. Never touch live data,
credentials or port 8399.

Drive actual `space.github.setPollingEnabled` requests. Reject configured-row,
Space-intent and session-scope capability SELECTs on the main connection. Verify
global capability and saved config after public readback. The separate timer
helper now serves all three timer callers; see their separate journeys. The public polling timer caller is migrated
separately under #9651; its Space-only proof is `lane-c-github-timer-reader.md`.
The capability audit refreshes its sibling-code pin without changing the owned
186-line bounded capability subtree. Never claim a full no-SQL-main result. Other read/public/runtime closure is not audited here.

Hold an actual native unused-reader reply, then enable polling with a newer RPC.
Releasing the old reply must retain the newer capability and intent. Also hold
the older enable operation's config getter after its writer reply; a newer
disable must remain authoritative after that old getter returns. Capability effects run in one main-owned queue: a newer data write can commit
while its capability acknowledgement waits for an older effect. Hold an admitted
older capability write after a newer data write has committed; the newer effect
must wait before reading the global flag. Verify health while that queue waits.
No SQLite transaction spans the wait. No persisted duplicate facts or new policy.
Reader rejection propagates after its known write, with no fallback, notification
or automatic replay. Preserve the command's configured/intent/session precedence
and parsing errors; command contracts are pinned by the construction journey.

Count complete reader/query/mapper modules, both touched capability helpers and
the queue owner and tail field. Count and pin the same existing global-config getter/setter
interface roots separately as not audited transitively. No new dependency
exclusions. Keep the scope at most 200 lines; timer callers have separate scoped proofs.
`lane-c-github-capability-measure.cjs` records 175 owned lines, the same get/set config interface roots, now 10
lines after #9663 and one smoke registration: 186 known, with no data exclusions.
Refresh the two existing capability interface pins and contracts in the writer
journey; the eleven retained interface roots now total 67 lines after helper retirement and the getGlobalConfig delegation. No new interface root is added.
Record RPC/read latency, clone bytes, loop lag, RSS and WAL. Held requests are not
latency-target passes; separate queue/SQL/clone timing is unavailable. Retain
`github-capability-reader.json` before shared cleanup. GUI, real GitHub, deployment,
startup/shutdown ownership and the final #8714 guard remain unverified.
