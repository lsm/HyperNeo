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

It then starts two ready coding todos through the todo runner, each stored with
a `backend` start target:

- the feature's ready slice is sent to the backend session, and its stored
  target becomes that send;
- the unreachable feature's slice stays a todo with its start target and a
  `session_unknown` wait reason, and nothing is dispatched.
