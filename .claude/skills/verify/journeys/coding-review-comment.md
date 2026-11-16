# A recorded Review verdict posts one labelled PR comment

Read shared isolation setup in `../SKILL.md` and `coding-assignment-results.md`.
This proof starts one real daemon on an ephemeral loopback port with a fresh
synthetic DB/home. `$RUN/bin/gh` runs `review-comment-gh.ts`, which answers the
ledger's identity, PR-list and hydration reads from `$RUN/pr.json` (head and
OPEN/MERGED state), issue-comment list and create calls from `$RUN/comments.json`,
and logs every call to `$RUN/evidence/gh.log`. Comments are posted only for PRs
the same sweep's ledger read confirmed open. Nothing reaches github.com; HTTP is
refused.

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
comments must exist: one per verdict a sweep saw stored, none from the repeat
sweeps. The sweep posts the stored fact, the same row the gate reads, so a
verdict replaced before any sweep saw it is never posted. The
synthetic stage facts do not survive the sweep, so the helper
re-observes the head before the second result. Each starts with `**HyperNeo recorded review: <VERDICT>**` and
names the reviewer model and harness, the verdict and the head. The reviewer
session id never appears. The helper prints the first comment as a sample.

Then a second Neo service on the same DB stands in for a restart: two sweeps
make no issue-comment calls, because each PR's posted marker is stored in the DB.
Next the PR moves to a new open head with a new review, and the stub answers
comment calls with a rate-limit error (and `/rate_limit` with a reset ten minutes
out): one sweep tries once and the next sweeps make no comment calls. Last, the
stub reports the PR merged and a third service starts: the still-pending review
gets no comment call, because the ledger read in that sweep shows the PR merged.

Keep `evidence/review-comment.json` (RPC inputs, replies, comments, gh calls).

Run `neo-coding-review-comment` unit tests for the outage retry, closed PRs,
moved heads, overlapping sweeps, a verdict that returns at one head, a restart,
a merged PR and a rate-limit hold.

Not verified here: real GitHub, the human's gh account, or the PR page rendering.
