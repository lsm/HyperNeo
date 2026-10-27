10. **Archive refuses a session a doing todo works in.** After journey 1 opened
    root, run `VERIFY_PORT=<port> .claude/skills/verify/archive-guard-check.sh "$RUN"`.
    It seeds a doing todo bound to HyperNeo session `verify-archive` and calls
    `neo.session.archive` twice. End state: while the todo is doing the reply is
    `live_todo` naming the todo; after it is marked done the guard passes and the
    adapter answers `not_found` (the session is fictional).

For bound-Neo authorization and real archival, use the shared metadata-only
setup from SKILL.md with the owned-daemon helper:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/neo-bound-archive.ts verify
```

This uses real SDK MCP tools/call with a server-bound Neo caller, the daemon's
registered operation and HyperNeo driver. The fixture binds a synthetic Neo
session and creates an idle worker with a saved conversation. It must archive
successfully, remain discoverable through work.find with includeClosed, and
serve the intact conversation through session.get and message.sdkMessages.
The existing session.update RPC reopens it to active. After a doing todo is
bound to it, a second Neo archive attempt must return live_todo.

No model, provider, desktop thread, simulator or real data is used. The helper
owns the ephemeral daemon and in-memory MCP transports, closes them in finally,
and saves archive.json through the shared evidence/cleanup wrapper. The
pre-fix MCP proof returns human_only. Signed test-first commit d9547366a also
records that bound-Neo refusal and tests unauthorized binding kinds/sources.
The small change reuses isNeoConversationSession, the same binding predicate
as the conversation/publication readers; local-user access remains available.
This proves MCP/RPC behavior and data retention, not browser layout or live
rollout. Read hyperneo build after merge and report a pending rollout without
restarting the human daemon.
