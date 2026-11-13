## An SDK process exit after streaming starts releases worker status

Use the metadata-only shared setup and `proof-run.sh` in SKILL.md. No provider,
model server, live database or fixed port is used.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/sdk-exit-worker-status.ts verify
```

The helper owns an isolated daemon and uses a scripted SDK iterator with a real
child process. The first attempt consumes kickoff and emits `system/init`, then
leaves its iterator pending without a result or rejection. RPC must observe that
init and report `work.status=running` before the helper terminates the child.
This isolates process-exit handling from startup and stream-silence watchdogs.

The existing terminal error and retry handling must start attempt 2 with the same
kickoff UUID. The replacement emits a successful result, and `work.status` must
become `done`, not remain `running`. Evidence is `sdk-exit.json`, with both
worker statuses, attempt inputs and resource cleanup. External HTTP is disabled;
all owned children and daemon resources close in finally.

Before the fix, process exit was watched only until the first SDK frame. The
pending iterator then prevented terminal finalization, attempt 2 never started,
and worker status remained `running`. Watch process exit for the whole turn and
route a post-start exit without a result through the existing terminal finalizer.
Do not add a timeout or treat a live iterator as failed while a provider retry is
still in progress.

Failing unit reproduction commit: `21c6447164`. The focused fixture persists
`processing` before the fix and `idle` after it; this RPC journey checks the same
transition through the user-visible worker status.
