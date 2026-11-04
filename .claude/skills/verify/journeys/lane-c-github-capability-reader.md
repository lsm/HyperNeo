# GitHub capability callback reader activation

Use shared setup in `../SKILL.md` and run `proof-run.sh` with
`lane-c-github-capability-reader.ts` under Bun and Deno. The helper owns a fresh
synthetic daemon, authenticated WebSocket, refusing GitHub/HTTP stubs and an
ephemeral listener. Stop processors and finish startup body copying before
measuring. Never touch live data, credentials or port 8399.

Drive actual `space.github.setPollingEnabled` requests. Reject configured-row,
Space-intent and session-scope capability SELECTs on the main connection. Verify
global capability and saved config after public readback. The separate timer
callback still has main reads: count/report those separately, never claim a full
no-SQL-main result. Other read/public/runtime closure is not audited here.

Hold an actual native unused-reader reply, then enable polling with a newer RPC.
Releasing the old reply must retain the newer capability and intent. Also hold
the older enable operation's config getter after its writer reply; a newer
disable must remain authoritative after that old getter returns. Epochs belong
to the main capability-effect owner; no persisted duplicate facts or new policy.
Reader rejection propagates after its known write, with no fallback, notification
or automatic replay. Preserve the command's configured/intent/session precedence
and parsing errors; command contracts are pinned by the construction journey.

Count complete reader/query/mapper modules, both touched capability helpers and
the epoch field. Count and pin the same existing global-config getter/setter
interface roots separately as not audited transitively. No new dependency
exclusions. Keep the scope at most 200 lines; timer wiring follows after merge.
Record RPC/read latency, clone bytes, loop lag, RSS and WAL. Held requests are not
latency-target passes; separate queue/SQL/clone timing is unavailable. Retain
`github-capability-reader.json` before shared cleanup. GUI, real GitHub, deployment,
startup/shutdown ownership and the final #8714 guard remain unverified.
