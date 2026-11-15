# Coding session target

Use the shared isolated daemon setup in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-session-target.ts
```

The helper boots an isolated daemon with the coding pack and creates two real
HyperNeo sessions over authenticated RPC. It records finished synthetic coding
todos that worked in them as `frontend` and `backend`, then runs the normal todo
runner dispatch against the daemon's registered driver operations.

- A todo asking to start `backend` reaches the existing backend session through
  `work.send`. Its stored target, worker ref and driver delivery are checked.
- Both earlier todo/session bindings remain, and the daemon still has two sessions.
- An unreachable feature session leaves its new todo pending with the original
  target and no start timestamp, while its previous worker binding is retained.

The job processor stays stopped. This checks durable driver delivery without a
provider turn. The helper prints explicit session, reuse and wait counts and
writes the RPC and dispatch outcomes to `session-target.json`.
