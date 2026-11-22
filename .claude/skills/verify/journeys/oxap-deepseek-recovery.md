# OXAP DeepSeek recovery fails once when the hub returns the old thread

Follow the isolation and pinned OXAP release instructions in
[First message in an OXAP DeepSeek chat](oxap-deepseek-first-message.md).
Run the proof twice with fresh evidence directories and the mode argument
shown below. Use `pending` for the second run.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oxap-deepseek-first-message.ts /absolute/oxap RELEASE-NAME SHA256 recovery
```

Both runs send a first message through the daemon and real hub with a
synthetic dsh peer, restart the hub, and send another message. The second run
also seeds a recovery already waiting for a new thread. The chat's public
message feed must show a failed delivery, with zero retries and a DeepSeek
error directing the user to a new chat. The saved transcript must have no
notice promising a replacement thread. The original thread ID and saved
recovery excerpt must survive.
