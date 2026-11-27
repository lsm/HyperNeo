# A queued Codex send is receipted by its client message id

Most Codex Desktop sends are queued through the app-server's `thread/queue/add`.
Codex does not return a receipt for them. When the message runs, Codex writes an
`item_completed` event whose `UserMessage` item carries the daemon's
`clientUserMessageId` as `client_id`, in the turn it ran in. The send outcome keeps
that id as `delivery.clientMessageId`. The turn reader adds each `client_id` to the
turn's inputs, so the turn gives its todo.

```bash
RUN=$(mktemp -d /private/tmp/hn-codex-queued-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/codex-queued-receipt.ts 9392 "$RUN"
```

A real isolated daemon, with a synthetic Codex state database and rollout, prints two
PASS lines:

- `neo.todo.add` and `neo.todo.continue` queue two sends on one thread through a
  synthetic shared app-server. `$RUN/bin/ps` reports no Desktop, so the queue path is
  used. Each recorded `work_delivery_inputs` outcome keeps the id that `thread/queue/add`
  received. Each is `delivered: false` with no receipt: the daemon does not guess one at
  send time.
- The rollout then gains three turns in the real shape: a rollout user message with
  its own `msg_...` id, plus an `item_completed` user item. The first and third carry the
  two client ids. The middle one has no `client_id`, like input typed by a human. After
  the `neo.pack.sweep` job records the turns, each queued turn's inputs hold its client
  id, the human turn adds nothing, and the coding pack's `own(todo)` returns the two
  queued turns only.

Nothing reaches the real Codex app or a provider; `open` is stubbed to refuse.
`$RUN/evidence/observed.json` keeps the peer calls, outcomes and recorded turns.

A rejected send whose message runs later is covered by
[turn-todo-rejected-send.md](turn-todo-rejected-send.md).
