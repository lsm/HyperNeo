10. **Archive refuses a session a doing todo works in.** After journey 1 opened
    root, run `VERIFY_PORT=<port> .claude/skills/verify/archive-guard-check.sh "$RUN"`.
    It seeds a doing todo bound to HyperNeo session `verify-archive` and calls
    `neo.session.archive` twice. End state: while the todo is doing the reply is
    `live_todo` naming the todo; after it is marked done the guard passes and the
    adapter answers `not_found` (the session is fictional).
