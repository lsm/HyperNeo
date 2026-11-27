# A rejected send that later runs gives its todo

A Codex send can be rejected as uncertain while its message still reaches the thread:
the app-server takes it, but its acknowledgement is unusable. The outcome is a failure
with no `ref`, so the worker is named only by the delivery row's `target.ref`.
`WorkDeliveryInputRepository.list(ref)` matches `target.ref` as well as `outcome.ref`,
so the client id the failure keeps finds the turn the message ran in. The turn then
gives its todo, by the core rule (`planTurnTodo` over `readTurnTodoFacts`) and the
coding pack's `own(todo)`.

```bash
RUN=$(mktemp -d /private/tmp/hn-turn-todo-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/turn-todo-rejected-send.ts 9393 "$RUN"
```

A real isolated daemon, with a synthetic Codex state database, rollout and shared
app-server, prints three PASS lines:

- `neo.todo.add` sends through `thread/queue/add`, which answers with an unusable
  acknowledgement. `$RUN/bin/ps` reports no Desktop, so the queue path is used. The
  recorded outcome is a failure without `ref` or `notSent` that keeps the
  `clientMessageId`; the row's `target.ref` names the worker.
- The rollout gains the turn the message ran in (an `item_completed` user item with
  that `client_id`) and a turn typed by the human. After the `neo.pack.sweep` job
  records them, `own(todo)` returns the turn the message ran in only.
- The core rule gives that turn its todo with role `do`. The earlier turn and the
  human turn give none: the worker was not started by a todo, so nothing falls back
  to a starting todo.

On `dev` before this change the second line fails: `own(todo)` is empty, since the
failure outcome has no `ref` and the row was found by `outcome.ref` only.

Nothing reaches the real Codex app or a provider; `open` is stubbed to refuse.
`$RUN/evidence/observed.json` keeps the peer calls, outcome, target and recorded turns.
