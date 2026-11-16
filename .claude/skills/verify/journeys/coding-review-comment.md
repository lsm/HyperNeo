# A recorded Review verdict posts one labelled PR comment

Read shared isolation setup in `../SKILL.md` and `coding-assignment-results.md`.
This proof starts one real daemon on an ephemeral loopback port with a fresh
synthetic DB/home. `$RUN/bin/gh` runs `review-comment-gh.ts`, which answers only
issue-comment list and create calls from `$RUN/comments.json` and logs every call
to `$RUN/evidence/gh.log`. Nothing reaches github.com; HTTP is refused.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-review-comment-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-review-comment.ts "$RUN"
```

The helper watches `synthetic/review-comment` and seeds one open ledger row.
Real WebSocket RPC `neo.coding.result` records an assigned Review pass on that
PR and must not call GitHub. Two coding pack sweeps follow, then a fail at
the same head and two more sweeps. The sweep spawns `gh` itself. Exactly two
comments must exist: one per stored verdict, none from the repeat sweeps. The
synthetic stage facts do not survive the sweep, so the helper
re-observes the head before the second result. Each starts with `**HyperNeo recorded review: <VERDICT>**` and
names the reviewer model and harness, the verdict and the head. The reviewer
session id never appears. The helper prints the first comment as a sample.

Keep `evidence/review-comment.json` (RPC inputs, replies, comments, gh calls).

Run `neo-coding-review-comment` unit tests for the outage retry, closed PRs,
moved heads, overlapping sweeps, a verdict that returns at one head and a PR
merged during a GitHub outage.

Not verified here: real GitHub, the human's gh account, or the PR page rendering.
