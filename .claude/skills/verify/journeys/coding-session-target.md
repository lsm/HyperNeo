# Coding session target

Use the shared isolated daemon setup in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-session-target.ts
```

The helper boots an isolated daemon with the coding pack, creates two real
HyperNeo sessions over RPC and records two finished synthetic coding todos that
worked in them as `frontend` and `backend`. It then asks the coding pack's
`workerTarget` hook, with live status from the daemon's own `work.status`
operation:

- unrelated work that asks to start a `backend` session is sent to the idle
  backend session instead;
- a later slice of the same feature follows it there;
- a feature whose recorded session `work.status` cannot find waits instead of
  starting another.

Todo dispatch does not call the hook yet, so this journey does not claim that
any worker was reused or started.
