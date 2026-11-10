# Worker-owned native worktrees

Read `../SKILL.md` and use its resource check and isolated proof wrapper. Run with
the installed Desktop-bundled Codex executable, not an unrelated CLI version:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/worker-owned-worktrees.ts \
  /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
```

This drives the production todo runner, work operations, native Codex adapter and
coding assignment operation. The coding outcome check, todo completion bookkeeping,
repository, PR metadata and model are synthetic. The native project is registered
through the real app-server project API. The loopback Responses
model requests real native shell tools; it cannot fabricate the filesystem receipts.
The real bundled app-server creates threads, executes Git, persists rollouts and
receives the reused turns through its native queue. No human database, credentials,
real provider, external GitHub, reserved port or Desktop UI is used.

Observe `worker-owned-worktrees.json`, individual probe receipts and `calls.json`:

- Two sequential coding todos use the same native thread and linked worktree. The
  second task begins on the first task's branch, fetches the target advanced after
  the first task, and creates its own task branch at that newer commit.
- A separate idle native thread is reused for Review. It receives the entire stage
  contract and checks out the supplied PR head, different from the latest target.
  Its filesystem verdict and native turn result name that exact SHA.
- All starts lack preparation. Project matching still identifies the original repo
  while the executed working directories stay in two separate managed worktrees.
  The dirty source checkout remains byte-for-byte unchanged and at its old HEAD.

After merge/deployment, rerun from the deployed checkout and retain the copied
evidence. The wrapper removes only its isolated temporary data. This proves the
native worker lifecycle and checkout behavior, not autonomous model compliance,
app rendering, real bot review, external-provider availability, or merge policy.
The legacy private-clone actor journey separately covers the explicit sandbox path.
