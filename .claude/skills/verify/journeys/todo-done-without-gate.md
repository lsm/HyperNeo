**Neo marks any live todo done, and what waited for it starts.**
Run `.claude/skills/verify/with-run.sh bash -c '.claude/skills/verify/todo-done-without-gate.sh "$RUN" 9367'`
(set `VERIFY_MOCK_PORT` when 8000 is busy). The script starts an isolated daemon,
stops it, seeds a never-started todo whose check cannot pass, a card asked about
that todo and a second todo that waits for it, and starts the daemon again.

End state, printed by the script:

- Before: the waiting todo is unstarted, and `neo.todo.close` still refuses the
  first todo with `card_unanswered`, the first of the gates it keeps.
- `neo.todo.done` with no reason returns the todo as `done`; it never started.
- The card asked about it is `retired`.
- The waiting todo starts. It then fails with `invalid_place`, because the
  fixture has no worker folder; the journey proves admission, not a worker run.

The script exits non-zero when `neo.todo.done` is refused, the card stays open or
the waiting todo does not start.
