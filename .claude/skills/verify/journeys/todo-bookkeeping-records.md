# Todo PR bookkeeping is recorded without blocking

Use the shared isolated metadata-only setup in SKILL.md. No model, provider,
actual worker, browser, real GitHub or credential file is used. External HTTP
is disabled. The helper owns its ephemeral daemon and closes it in finally.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/todo-bookkeeping-records.ts verify
```

The real agent MCP door opens an ask whose PR URL is not yet known, adds a
duplicate PR todo, edits a PR check another todo tracks, and attaches URLs to
a todo whose check cannot consume them. Each succeeds and returns records;
the title edit applies and the unsupported check remains unchanged. Accepted
records persist in the operation audit, distinguished from refusals by accepted=1,
and survive a daemon restart. Evidence is observed.json and proof.log; the
wrapper saves evidence before removing all synthetic data.
The agent-facing operations.describe response must also describe duplicate PRs
as recorded without blocking, before and after restart.

This proves agent receipts and durable audit records, not visual web layout.
Malformed PR URLs still fail validation, and existing unanswered-card and
cancelled-turn mutation protections stay enforced.

For the row 5a policy extraction, run this helper before and after the move in
separate fresh evidence directories. Both runs must retain the same accepted
bookkeeping records across restart. The focused policy contracts cover the
runtime pack and standalone synchronous factory, including current claim reads,
URL normalization, self ownership and `closed_unverified` peers. This extraction
does not move the runtime admission or write callers onto the DB worker; those
remain later slices of #8712.
