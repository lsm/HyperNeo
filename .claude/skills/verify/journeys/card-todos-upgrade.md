**A card lists the todos it covers, and an upgrade keeps today's holds.**
Run `.claude/skills/verify/with-run.sh bash -c '.claude/skills/verify/card-todos-upgrade.sh "$RUN" 9367'`
(set `VERIFY_MOCK_PORT` when 8000 is busy). The script starts an isolated daemon,
stops it, rewrites its database to the shape before cards had a `todos` list
(three legacy cards, no column, migration 502 unmarked) and starts it again.

End state, printed by the script:

- `q-ask` (no todo), `q-one` (one todo) and `q-start` (a Start card) read
  `["held"]`, `["waiting"]` and `["waiting"]` in `todos`.
- `held`, an approved todo under the ask-level question, is still unstarted
  after the queue has admitted `free`, the same todo in an ask with no card.
  `free` then fails with `invalid_place`, because the fixture has no worker
  folder; the journey proves admission, not a worker run.

The script exits non-zero when a list is wrong or `held` starts.
