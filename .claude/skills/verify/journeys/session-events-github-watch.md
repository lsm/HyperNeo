# Session GitHub watch through gh with Space off

Prove a session on a fresh Space-off daemon with no GitHub token can subscribe to a
pull request and receive a new review through the real poller. A synthetic `gh` on
the daemon's `PATH` answers the GitHub API paths and all direct HTTP is refused, so
no key or network is used. Run from the worktree root:

```bash
HYPERNEO_SPACE=off bash .claude/skills/verify/proof-run.sh "$PWD/.evidence-session-watch" \
  .claude/skills/verify/session-events-github-watch.ts
```

`session-events-watch.json` must show `pass: true`, `subscribe` as `ok: true`, one
`sessions` row in `watched`, a `pull_request/8.review_submitted` entry in `events`,
and that event in `deliveries` as `pending` with the saved session message in
`message`. No model turn runs, so `delivered` is not reached here.

`quietPoll` and `reviewPoll` report `errors: 1`: the stub answers the repo path with an
array, so `lastPartialPollError` names `Neo read checkout`. That is deliberate, because
a valid answer could send the daemon to run a real git fetch. Polls run through
`space.github.pollOnce`; the timer path and real GitHub are not covered here.
