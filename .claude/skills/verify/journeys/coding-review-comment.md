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

Real WebSocket RPC `neo.coding.result` records an assigned Review pass, then the
same pass again, then a fail at the same head, then that fail again. The daemon
spawns `gh` itself. Exactly two comments must exist: one per stored verdict, none
for the repeats. Each starts with `**HyperNeo recorded review: <VERDICT>**` and
names the reviewer model and harness, the verdict and the head. The reviewer
session id never appears. The helper prints the first comment as a sample.

Keep `evidence/review-comment.json` (RPC inputs, replies, comments, gh calls).

Not verified here: real GitHub, the human's gh account, or the PR page rendering.
