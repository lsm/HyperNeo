### Private GitHub home proposal (H3 slice 2)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/neo-home-github.ts <port> "$RUN" verify`.
The helper replaces only the isolated daemon's stub `bin/gh`. Its allowlist answers
auth status and the synthetic owner lookup; private creation connects and pushes
to a local bare Git repository. Every other GitHub command fails. Never run this
with the real HOME, remotes, credentials or GitHub executable on the daemon PATH.

The actual RPC must refuse missing/open consent before any create call, show the
daemon-bound repository in the question, accept its recorded human yes, and call
private creation exactly once. The initial commit must reach only the synthetic
remote, with upstream configured and clean status. The helper plants an executable
pre-push hook in the writable home, pointing at a marker in its synthetic run. The
daemon's gh child must push successfully without executing that hook;
evidence.hookExecution must be null. Focused contracts also verify that inherited
Git configuration still selects the configured push destination.
Repeated proposal/application calls return the stored receipt. Stop and restart this same isolated daemon, then
run the helper with `restart`: the persisted question/creation receipt must avoid
another external submission. Evidence: `evidence/neo-home-github-<mode>.json` and
`evidence/home-gh.log`.

In separate fresh runs, `decline` verifies human no stays local and reuses its
question, and `unavailable` verifies failed auth is probed once with no question or
creation. On pre-feature dev, `before` records the unknown-operation baseline.
Focused contracts additionally refuse agent answers, foreign/retired/unrelated
consent, replacement repository fields and existing origin, preserve unrelated home files, and
reserve once across concurrent calls and an uncertain external failure. Such a
failure may have created the repository remotely: reconcile with the human rather
than replay creation. No actual GitHub creation, credentials, model or GUI are
verified. The first proposal is explicitly requested with the current root askId
after setup; re-proposal on a later human request, cloning and wake reads remain
later work. Stop the daemon/mock with `stop.sh` in the same shell as launch.
