# Required Neo todo completion checks

Use the shared isolated metadata-only setup. This helper owns an ephemeral
loopback daemon port, a fresh HOME/data/database and a refusing GitHub stub. It
has no model, provider or credentials and closes the WebSocket and daemon in
finally. The wrapper preserves evidence and immediately removes temporary data.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/todo-check-input.ts verify
```

The baseline must fail when the real WebSocket operation door accepts a new todo
with only a title and free-text completion sentence. The fixed daemon refuses
that request, accepts a supported check without doneWhen, and derives its
completion sentence. Unknown packs are refused. A synthetic old row with no
check remains readable; editing its check derives new wording and creating the
named result file lets the normal completion operation mark it done.

The shared draft schema also covers todos supplied to neo.ask.open. Focused
contracts cover missing/null checks, unsupported kinds, removed input fields,
legacy rows, URL edits and current completion-check revalidation. This proof
covers agent/RPC receipts and persisted state; it does not verify visual layout.
