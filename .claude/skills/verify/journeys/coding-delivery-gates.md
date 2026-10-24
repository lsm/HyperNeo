# Coding delivery evidence storage (build slice)

Use shared isolation in `../SKILL.md`. This backend build slice has no model,
HTTP mock or browser. It exposes `recordSmoke` on the coding pack and adds
per-todo/PR/head receipt storage without changing dispatch or todo completion.
Exercise that exact API in an actual isolated daemon, then reopen its synthetic DB:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-delivery-proof-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-delivery-gates.ts "$RUN"
```

The helper seeds a synthetic gate receipt. It reuses `readGithubDeploys` with
synthetic merge/build ancestry effects and its optional head reader; unexpected
GitHub commands and external HTTP throw. Legacy deploy reads stay unchanged;
smoke requires a merged-head observation and refuses missing or different heads.
Check `evidence/observed.json`: an ungated merged head, author attempting smoke,
and absent deployment all refuse. Author and QA deliberately share a local ID
on different daemons, exercising full WorkRef independence. Full references on
stage facts survive storage and app restart; historical facts without refs remain
valid storage inputs but cannot supply full-ref evidence to the later merge gate.

A smoke pass followed by a failure retains the failure after reopening the app;
an explicit docs-only inapplicability reason is then recorded. The todo remains
doing throughout: completion wiring belongs to a later slice. Historical head
receipts are preserved and never satisfy another head. Both daemon instances
close in finally. Keep the evidence outside the worktree. The regression commit
71b407faf5 reproduced acceptance of smoke for head-b under a head-a gate; retain
that failed evidence alongside the fixed run.

This proves pack smoke API behavior and persistence, not live GitHub transport,
a real deployment, merge preparation, actor dispatch, or final todo completion.
Merge preparation follows in the next unstacked slice. The wire slice must add an
operation-door/completion journey before #8429 is complete.
