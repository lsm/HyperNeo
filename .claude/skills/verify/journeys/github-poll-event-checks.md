# GitHub feedback delivery reuses the completion-check interval

Read `../SKILL.md`. This journey uses an isolated daemon's public `/ws`
`space.github.pollOnce` RPC, a synthetic database and an executable GitHub stub.
It needs no model, HTTP mock or GUI. All HTTP fetches are refused; the stub
accepts only its synthetic API reads and PR completion reads. It never reads
credentials, contacts GitHub or uses port 8399.

Run from the worktree root with a fresh directory:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-poll-event-checks-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-poll-event-checks.ts verify "$RUN"
```

The helper seeds two doing todos in different repositories and follows the
first PR's events. The first poll returns eight feedback comments. Inspect
`evidence/poll-event-checks.json` and `evidence/requests.jsonl`:

- All eight comments reach the owning worker's mailbox. Model consumption is
  not tested; the job processor is stopped before the fixture is seeded.
- Both repositories acquire a fresh last-poll timestamp. The feedback burst
  makes one completion read, reusing the existing two-minute check interval
  thereafter. Each comment carries its original commit ID. A head-bound event
  newer than the cached PR observation still forces a fresh read before routing;
  historical comments reuse that newer observation. The burst does not sweep the
  unrelated todo or its worker.
- A second poll reports the target PR merged. It forces a fresh check despite
  the recent interval: the target todo becomes done immediately, while the
  unrelated todo remains doing.

The helper closes its WebSocket and daemon in `finally`. Keep the JSON evidence.
At reproduction commit `a9ad5c24bc`, use `before` instead of `verify`: the same
eight comments produce nine completion reads while still delivering eight
mailbox entries. The fixed proof requires exactly one feedback completion read.

Focused contracts in `neo-card-pr-events.test.ts`, `neo-coding-todo-prs.test.ts`
and `neo-todo-runner.test.ts` also retain current-head filtering, terminal
subscription closure and ordinary periodic completion checks. The first feedback
event still refreshes an expired or missing check; it is not skipped entirely.

This proof measures synthetic completion reads, not live API quota savings.
It does not resolve response-size refusals or establish why a stored GitHub
404 occurred. Live freshness requires a separate read-only check after deployment;
never invoke pollOnce on the human's daemon to manufacture that evidence.
