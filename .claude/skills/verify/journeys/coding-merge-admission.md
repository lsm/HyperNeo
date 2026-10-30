# Recorded manual merge admission through the operation door

Use shared isolation from `../SKILL.md`. This metadata-only helper owns a real
isolated daemon, an ephemeral loopback port, fresh home and DB, and a GitHub CLI
fixture. No provider, model, HTTP mock or browser is needed. External HTTP throws;
the CLI fixture logs reads and refuses merge/deploy commands.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-merge-admission-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-merge-admission.ts "$RUN"
```

The committed contract-first proof fails before the operation exists. After the
wire, real WebSocket `neo.coding.merge.prepare` reads its persisted assignments,
actual paginated review verdict, required checks and complete review threads.
It refuses absent Verify, stale/negative bot review, pending/failing CI, unresolved
findings, missing applicable human sign-off and a head changed at the final read.
Only a passing case records a receipt and returns the exact SHA-pinned manual
squash command. It executes no merge and leaves the todo doing.

Bare path globs `README.md` and `*.md` must still require human approval when
README.md changes and the PR has no labels. The real RPC first admits a control
with no sign-off rule, refuses with each bare path rule, then admits only after
a current non-author human approval. `observed.json` retains `barePathProof`.
This pins the existing path behavior alongside the actual-label regression;
bare patterns participate in both file and label matching.

Keep `evidence/observed.json` (`verified: true`) and `evidence/gh.jsonl` outside
the worktree. The fixture preserves a null-user historical review and puts the identified bot
and human approvals on later pages. Use `coding-review-pages.md` for installed
gh handling 101 records over two actual local HTTP pages through `runGhJson`.
Unit contracts also cover the no-bot assigned reviewer, author/ref
changes, policy changes, latched failure, path/label sign-off and inaccessible
facts. The fixture uses `neo.coding.assign` for the bot route and seeds only the
synthetic Verify assignment; it does not claim a real model or native-harness run.
Use `coding-actor-assignments.md` for real isolated preparation with a synthetic
harness, `coding-merge-guidance.md` for delivered instructions, and
`coding-delivery-completion.md` for post-deploy smoke and historical completion.
Live GitHub transport and deployment are not verified here. The helper closes
its own socket and daemon in finally and never touches the human's running app.

Use --bot-alias before the final run-directory argument to repeat with GitHub's
REST fixture-bot[bot] login against a saved fixture-bot policy. The same complete
operation-door cases must pass. The helper accepts the shared proof-run.sh wrapper;
that wrapper retains evidence and removes its owned daemon data.

The --human-collision mode seeds the saved fixture-bot[bot] policy directly
because the current preference tool refuses suffixes and supplies an APPROVED review
from the distinct fixture-bot User. This must refuse admission without recording
a gate. It then supplies the genuine Bot and repeats the complete admission
proof. Unknown actor types are covered by the focused policy contracts.
