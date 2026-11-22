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
