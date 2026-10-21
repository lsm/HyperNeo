13. **Root Neo owns goals outside any Space.** After journey 1 opened root, run
    `VERIFY_PORT=9311 .claude/skills/verify/session-goal.sh "$RUN"`. It creates a goal
    for root through `goal.session.create`, first without metrics or a done-test, then
    with one, updates it, and lists it. End state: `evidence/goal-refused.json` holds
    `done_test_required`; `goal-list.json` lists "Grow OAP" at progress 40 with its
    done-test, mandate link and next step; `goal-events.txt` reads `created|human`
    then `updated|human`. The script then appends a journal entry twice for the same
    run: `goal-journal.json` holds one entry for `run-1`, with the second effect
    ("Three projects asked for it") and the PR as evidence.
