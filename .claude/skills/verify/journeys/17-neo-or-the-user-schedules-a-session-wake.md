17. **Neo or the user schedules a session wake.** `session-schedules.sh <port> "$RUN"`
    creates a session and calls `schedule.session.*` as the local user. End state: a
    1-second cadence replies `invalid_cadence`; an hourly reminder is `active` with
    one pending `sessionSchedule.fire` job an hour out and appears in `list` for that
    target; `pause` makes it `paused` and drops the job; `resume` makes it `active`
    with a new job; `delete` removes the row and its job. Journey 20 verifies delivery.
