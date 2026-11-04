# Coding stage todo descriptions (Build)

Use shared isolation and cleanup in `../SKILL.md`. The helper starts one fresh
synthetic daemon on an ephemeral loopback port and invokes the installed coding
pack through real `neo.todo.add` and `neo.todo.edit` WebSocket RPC. No provider,
model, browser, real GitHub, real credentials or reserved port is used.
The RPC socket uses only the fresh daemon's owner-only local credential, as
described in shared setup. Only
`work.start` is replaced with a synthetic chooser that honors worker exclusions.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/coding-stage-todos.ts
```

Observe `coding-stage-todos.json`: Review and Verify are separate doing todos in
the author's ask. Their worker bindings and dispatch receipts come from core,
with author and earlier actor excluded. The existing verdict repository is the
synthetic recording edge; fail and inconclusive are completed stage work, never
an approving verdict. Core completion closes each stage and frees its worker;
the author's merge todo stays doing. A new head has a new pending stage todo and
cannot consume an older verdict. `neo.ask.read` confirms the same doing/done
states on the public work card. No worker identity is written to pack facts.
Unit tests cover malformed metadata, exact binding/head/contract checks,
stall shielding and complete role-contract delivery after core prompt formatting.

This is a construction proof: public `neo.coding.assign`/`neo.coding.result`
wiring, native worker reuse, real model behavior and UI rendering are not proved.
The helper closes its socket/daemon in finally. The wrapper retains evidence
before removing the fresh synthetic home/data.
