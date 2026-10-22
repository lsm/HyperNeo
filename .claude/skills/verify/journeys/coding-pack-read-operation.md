# Coding-owned GitHub read operation

This step-2 boundary moves `neo.github.read` into the coding pack. Core registers
installed pack definitions through its existing Neo admission pipeline. The
operation's schema, policy, description, result and acquisition behavior remain
unchanged; disabling coding work guidance does not remove this existing read.
No ledger API, collector, state projection or GitHub acquisition change is made.
The complete core/pack import guard and remaining composition/project-tree/prompt
separation are later work.

Read shared SKILL.md setup and `github-ledger-consumer-contracts.md`. Reuse its
merged public-RPC helper without changing its assertions or stub. Each scenario
needs a fresh absolute directory; it owns an ephemeral non-8399 daemon and stops
it in finally. From the worktree root:

```bash
for scenario in merged head unreadable; do
  RUN=$(mktemp -d /private/tmp/hn-pack-read-XXXXXX)
  mkdir -p "$RUN/home"
  env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
    NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
    bun .claude/skills/verify/github-ledger-consumers.ts "$scenario" "$RUN"
done
```

Observe each `evidence/consumers.json` and `requests.jsonl`: the public detail/list
RPC results agree with branch, deploy and ledger facts; old-head approval drops;
unresolved blockers remain; unreadable is refused, successful empty is empty, and
partial reconcile retains previous facts. The merged request baseline remains
seven initial / three repeated calls; ledger GraphQL cost remains 14, other cost
unknown. These unchanged counts are not a quota or performance improvement.
The reused helper's historical `baseline` / `productionChanges` labels describe
its original Pin fixture, not this PR's source diff. Retain the current source
head separately with the observations rather than rewriting captured evidence.

New CI contracts check generic pack-operation admission and disabled-coding read
availability; existing signature and live-reader-replacement assertions stay
unchanged. The minimal intake registration fixture supplies `installedPacks`;
no production fallback is added for mocks. Unit suites run in CI only.
No model, real GitHub, credentials, GUI, live DB or 8399. This helper does not
measure RPC latency, SQL duration, RSS or event-loop lag; those goals remain
unverified by this ownership-only slice. Retain evidence, manually merge only
on eligible exact-head approval/green CI, verify deployed commit via RPC
`hyperneo build`, stop owned services and remove the completed worktree.
