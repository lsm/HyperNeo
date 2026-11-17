# An unchanged PR costs no core REST calls on the next merge-facts read

Read shared isolation in `../SKILL.md`. Like `coding-ledger-live-cost.md`, this
journey is an opt-in, read-only live check for GitHub budget changes. Only the
parent process runs the already configured `gh`; never inspect its credential
files. No daemon is started and the database is in memory.

```bash
NODE_ENV=test HYPERNEO_DATA_DIR="$(mktemp -d)" \
  bun .claude/skills/verify/github-conditional-reads.ts \
  https://github.com/lsm/HyperNeo/pull/<open PR> /absolute/fresh/evidence
```

The helper runs the real `readCodingDaemonMergeFacts` twice on one public PR.
Its spawn wrapper refuses anything but `gh pr view`, `gh pr checks` and API
reads, and records the HTTP status and `x-ratelimit-resource` of every REST
answer. Both reads must succeed. On the second, the per-PR REST reads (reviews
and labels) must carry `If-None-Match` and come back `304`, so no counted core
call is made. GraphQL reads are unchanged. A PR edited between the two reads
fails the run; pick a quiet one and rerun.

`github-conditional-reads.json` keeps each pass's calls and statuses. It
records no response bodies.

The sweep's budget guard is covered by the unit suite with the real sweep and
attention mailbox (`coding-daemon-merge-sweep.test.ts`, "shared GitHub budget"):
below 20% only `approved_green` PRs are read and still merge, below 5% Neo gets
one `coding.github_budget` wake naming the reset time, and every confirmed merge
logs `Daemon merge confirmed`.
