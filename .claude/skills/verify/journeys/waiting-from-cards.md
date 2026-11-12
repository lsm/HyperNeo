**Waiting on the human is read from cards by the list, the counts and the runner.**
Run `.claude/skills/verify/with-run.sh bash -c '.claude/skills/verify/waiting-from-cards.sh "$RUN" 9367'`
(set `VERIFY_MOCK_PORT` when 8000 is busy). The script starts an isolated daemon,
stops it, seeds a parent ask whose open card covers the only todo of its child ask,
plus a third ask with a todo and no card, and starts the daemon again.

End state, printed by the script:

- Before the answer `neo.snapshot` reads `child=waiting parent=waiting needsYou=2`,
  and the covered todo is still unstarted after the queue has admitted the todo
  with no card.
- After `neo.question.answer` the covered todo starts, no ask reads `waiting` and
  no card is open. Both started todos then fail with `invalid_place`, because the
  fixture has no worker folder; the journey proves admission, not a worker run.

The script exits non-zero when the three readers disagree or the covered todo
starts under its open card.
