# Passing checks decide todo completion

Use the shared metadata-only isolation setup. No provider, model, browser or real
GitHub is needed. The helper owns a daemon on port 0, invokes its actual scheduled
driver-refresh job and reads each ask through the real WebSocket RPC door.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/todo-completion-facts.ts verify
```

The refusing GitHub stub permits only synthetic PR views and issue-state queries.
Merged PR and completed issue checks must finish doing todos even when a coding
assignment has no delivery receipt. They must also finish todos held by an old
human card or worker block. The old todo card retires with its answer still null;
an open PR stays blocked with its human card open, and removed work stays removed.
Full worker reports survive, and another scheduled refresh does not change the
completed rows. This proves automatic completion and public RPC state, not visual
layout, real deployments, or live GitHub state.

The merged-delivery worker also mentions another PR whose owner is unknown.
That incidental link must not hold the named merged-PR check open: the scheduled
refresh must close the todo and the public ask RPC must show Done. Run this
fixture before the fix and retain its failing RPC observation, then repeat on
the fixed tree. Extra owned PRs may remain in the todo view without changing
the verdict of a check that names its required PRs.
Pass `named` instead of `verify` to the same helper for the focused named-PR
regression without the independent legacy-pack and issue-completion fixtures.

A synthetic legacy pack is installed at the test daemon's pack seam and returns
both done and an explicit failure. The scheduled refresh must preserve failure
precedence: the public ask read shows Failed with that reason. This fixture does
not replace the runner or state reducer. The helper restores the pack seam on exit.

Run against the baseline first: it must fail with a still-doing delivery todo or
a still-blocked human todo, then pass after the fix. The wrapper preserves all
RPC replies, stored rows and stub calls before removing the synthetic HOME/data.
The helper closes the WebSocket and owned daemon in finally, including failures.
For the legacy-precedence regression, the baseline must fail because the same
public read incorrectly shows Done for the conflicting result.

Closed-without-replacement PR judgements must preserve failed
todos instead of replacing their recorded outcome or sending another failure
notice. The same terminal state must still become Done when its PR merges.
