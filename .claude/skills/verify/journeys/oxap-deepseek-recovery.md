# OXAP DeepSeek continues after a hub restart

Follow the isolation and pinned release instructions in
[First message in an OXAP DeepSeek chat](oxap-deepseek-first-message.md).
Run each mode with fresh evidence directories.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oxap-deepseek-first-message.ts /absolute/oxap RELEASE-NAME SHA256 recovery
```

In `recovery` mode the second message follows a hub restart. The synthetic dsh
peer accepts native resume and the chat receives a reply on the same thread
without a new-thread notice. Use `flash-recovery` to confirm that a Flash thread
keeps its model after resume. In `pending` mode a replacement was already
requested before restart. The next reply arrives on a different thread and the
chat shows one replacement notice.

Use `locked-recovery` to exercise `work.send` after restarting the daemon.
The synthetic peer takes an exclusive lease on its native session. Reopening
takes that same lease, so a concurrent resume is refused. The check requires
the failed input and its reason in the worker chat, the reason in the originating
sender's durable inbox, and failed work status with the same reason.

Use `refused-reopen` for a refusal from the first native resume attempt.
The same sender and chat checks apply, and the worker retains its native ID.
