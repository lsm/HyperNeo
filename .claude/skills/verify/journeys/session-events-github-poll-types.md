# Every polled GitHub event type on a fresh Space-off daemon

Prove the poller handles realistic payloads for each event type it reads on a fresh
Space-off database, with no token. A synthetic `gh` answers REST-shaped responses and
all direct HTTP is refused. Run from the worktree root:

```bash
HYPERNEO_SPACE=off bash .claude/skills/verify/proof-run.sh "$PWD/.evidence-poll-types" \
  .claude/skills/verify/session-events-github-poll-types.ts
```

Three polls run: quiet, activity and closed. `session-events-poll-types.json` must
show `pass: true` and `topics` with `polled`, `comment_polled`,
`review_comment_polled`, `review_submitted`, `check_failed`, `merge_conflict`,
`reaction_added` and `closed`, plus an empty `subscriptionsAfter.stored`, because a
closed PR ends its subscription. `proof.log` must have no `no such table`.

Each poll reports `errors: 1` from `Neo read checkout`, a deliberate stub gap described
in `session-events-github-watch.md`. Not covered: push and other webhook-only types,
check-run conclusions other than `failure`, fork PRs, 403/404 answers on the check-run
path, the timer, real GitHub, and `delivered`, because no model turn runs.
