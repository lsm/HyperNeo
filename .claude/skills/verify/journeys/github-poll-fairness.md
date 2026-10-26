# GitHub polling gives each watched repo a share

Read the shared setup in `../SKILL.md`. This helper owns an isolated daemon and
uses an in-process GitHub fetch mock; it needs no model HTTP mock or GUI.
No real GitHub request, credential lookup, live DB or port 8399 is used.

From the worktree root, choose a free port (the example uses 9361):

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-poll-fairness-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/github-poll-fairness.ts verify 9361 "$RUN"
```

The helper refuses a pre-existing data directory, installs a gh stub that sends
only structured API reads to its own loopback fixture, and rejects any fetch
outside the synthetic GitHub API. It extracts no credential. It seeds only its own
DB: one repo with 201 subscribed PRs and remembered heads, plus three one-PR
repos. All four initially have `last_poll_at = NULL`, including the large repo,
so putting the previously polled repo last cannot masquerade as request sharing.
Each simulated quota window supplies only 40 requests, with fresh approvals on
the three small repos. The requests enter through the real public `/ws`
`space.github.pollOnce` RPC, three times.

Observe `evidence/polling.json`:

- Each cycle publishes all three small-repo approvals and enqueues their actual
  owner mailbox entries: at least 3, 6, then 9. The job processor is paused so
  no provider/model or real desktop session is launched; model consumption is not
  verified by this journey.
- Every repo has a non-null last-poll time. The large repo's saved cursor and
  request paths advance rather than restarting its first heads on each slice.
- Each cycle stays within the mock quota, keeping at least 10 requests unused.
  This guarantee requires enough available quota to serve the watched repos;
  actual rate-limit/Retry-After responses still stop calls. Repos with the oldest
  successful poll get the next chance when a window is insufficient.
- Current feeds are refreshed while a long detail/check/review scan resumes;
  a one-request share alternates feed refresh and continuation so neither is
  permanently stuck. Reactions retain their higher quota floor; PR details and
  formal reviews use the ordinary reserve.

The pre-fix source at reproduction commit `220d417c1e` with this same helper
copied into it supports `reproduce` instead of `verify`: one RPC spends 31
requests, reaches remaining 9, and leaves all three small repos unpolled with no
approvals or owner mail. Preserve that run's JSON as the before evidence.
Focused Vitest contracts also cover all 201 detail targets over repeated slices,
extension restart, paginated reviews, and check-page supersession across a pause.

The helper closes its WebSocket and cleans up its daemon in `finally`. Keep the
JSON evidence. Legacy closed-subscription replay and an N-cycle Neo starvation
concern are separate follow-up slices; this journey does not claim they exist.

## Newly discovered PRs during a resumed scan

Run the same isolated command with `resume-verify` instead of `verify`, using a
fresh RUN and a free port. It seeds persisted stage-4, stage-5 and stage-6 resume
positions, not a killed daemon. A newly subscribed PR appears before the saved
position, with an approval, positive reaction and failed check at 00:01; its feed
update at 00:02 is newer. The legacy cursor deliberately has no check-enabled
baseline. Three real `space.github.pollOnce` calls must publish each signal
exactly once for every repo, including the newly discovered PR, and enqueue
owner mail. Inspect every cycle in `evidence/polling.json`.

The completing resume must retain the old global cutoff at 00:00 even when it
has no further continuation. The following full scan delivers previously skipped
signals; only then may the global cutoff reach 00:02. Per-endpoint and per-head
cursors still advance during slices. Repos requiring a slice every cycle may
retain that conservative global cutoff; deduplication prevents repeat delivery.

At reproduction commit `cdc532fd3`, use `resume-reproduce`: approvals are absent
for stages 5/6, the stage-6 reaction is absent, and the stage-4 failed check is
absent after all three polls. This is the P1 regression, independent of the
40-request fairness fixture. The helper checks those losses and retains the
before evidence. `resume-verify` must fail on that source and pass after the fix.

## Restore missing watches and report stale polling

Run `reconciliation-verify` with the same isolated setup and a fresh RUN. The
fixture removes every persisted watch, restarts its daemon, and requires startup
to reconstruct all subscription watches plus an open coding todo's repository.
It then removes three subscription watches again before the first RPC cycle;
all must regain polling and approvals reach their actual owner's mailbox within
the same 40-request synthetic quota. A todo-only watch survives every cycle
until its todo finishes, after which normal cleanup removes it.

Finally the fixture binds the synthetic owner as Neo and returns a synthetic
rate-limit response. Four RPC cycles must persist a `polling:<owner>/<repo>`
health incident for each remaining watch and accept each concern into Neo's
mailbox. Inspect `staleHealth` and `mailbox` in `evidence/polling.json`. This
reuses coding health notice delivery but keeps polling incidents separate from
ledger coverage incidents. The threshold is three missed enabled cycles,
including cycles deferred by rate limits; disabled scopes do not count.

The unit contracts cover recovery and rejected-wake retry. The separate
`github-terminal-replay` journey verifies final-event acceptance before automatic
unsubscribe. This journey does not verify a model consuming mailbox messages;
live non-HyperNeo approval delivery remains a separate post-deploy check.
