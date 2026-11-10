# Pack exclusions through core todo dispatch (Build)

Use shared isolation and cleanup in `../SKILL.md`. This construction proof boots
one fresh synthetic daemon on an ephemeral loopback port and uses the real
WebSocket `operation.invoke` door for `neo.todo.add {start:true}`. No model,
provider, browser, external HTTP or reserved port is used.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/pack-worker-start-exclusions.ts
```

The fixture installs the production core ask/todo operations and runner with a
generic test pack in the daemon operation registry. It replaces worker dispatch
with a synthetic candidate chooser; this is a hook construction proof, not the
coding pack's public assignment wiring or a native worker reuse proof. The pack
reads excluded workers from existing todo bindings; it writes no core state.

Observe `pack-worker-start-exclusions.json`: the RPC adds work in the existing
ask, excludes the author and earlier actor, and core records the independent
worker's binding and acknowledged delivery. Its todo is doing without a blocker.
A missing required binding makes the next todo fail with the pack's refusal,
without another dispatch, delivery input or worker binding. No identity is copied
to pack facts. Unit coverage also observes doing/pending before the start receipt,
unchanged no-hook starts, and explicit sends unaffected by start policy.

The helper closes its socket and daemon in finally; the wrapper retains evidence
then removes the synthetic home/data. Coding stage descriptions, completion,
assignment/result wiring, autonomous stage behavior and UI rendering remain
unverified by this Build proof and require their later slices.
