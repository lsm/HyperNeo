23. **An external worker can report milestones to its sending Neo.**
    Run `RUN=$(mktemp -d /tmp/hn-reply-XXXXXX)` then
    `bun .claude/skills/verify/external-reply-check.ts <free-port> "$RUN"`.
    It refuses 8399 and a busy port, starts a real isolated daemon in test mode
    with an empty environment and its own HOME/DB, and registers a synthetic
    Claude Code peer on a private Unix socket. No provider, mock-model port or
    GUI is needed. The script seeds only this run's ask/todos/start questions,
    then answers the start questions through real RPC so the todo runner sends
    its instructions through the native Claude inbox transport.

    End state: `$RUN/observed.json` records the worker's actual incoming frames.
    The first instruction includes `hyperneo send <the actual root Neo id> --kind <kind>
    "<text>"`; an instruction already containing that line has one copy; a
    human-origin send has none. The script then runs the real CLI with a
    the synthetic Claude peer's sender identity and checks read-only that its blocker
    message reached that Neo's transcript. It stops its daemon and closes its
    peer socket even when an assertion fails. Save `observed.json` and the
    console output as before/after evidence, then remove the run directory.
    This proves real RPC/todo/inbox/CLI delivery with a synthetic peer, not
    Claude Desktop or Codex Desktop GUI rendering; those routes and direct
    `work.send`/`work.start` are covered by the daemon unit tests.

    The received brief must limit reporting to PR opened/merged/closed, blocked,
    a question, done or failed, with no acknowledgments or progress pings. The
    helper asserts that policy on the actual inbox frame and sends a structured blocked report
    through the CLI. This proves prompt delivery, not model compliance or queue
    filtering (the latter is tracked separately in #8647). It also asserts workerReportKind=blocked survives into the persisted transcript. No model turn is claimed by this transport-only journey.
