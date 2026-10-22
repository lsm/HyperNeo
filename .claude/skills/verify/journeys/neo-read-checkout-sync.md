# Neo reads current code without updating the human's checkout

Read `../SKILL.md`. This journey uses the existing GitHub poll RPC on an isolated
daemon, an executable GitHub API fixture, and a real synthetic bare Git origin.
No model, provider key, real GitHub request, live database or GUI is needed.

```bash
RUN=$(mktemp -d /private/tmp/hn-neo-read-sync-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_USE_DEV_PROXY=1 HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/neo-read-checkout-sync.ts verify "$RUN"
```

The helper refuses a reused daemon data directory. It owns an ephemeral daemon
port (never 8399), stops its job processor before seeding the watched repository,
and invokes public `space.github.pollOnce` through `/ws`. Its GitHub CLI fixture
reads the default ref SHA from the real bare origin. An isolated HOME Git URL
rewrite directs only `synthetic/neo-read-proof` to that local origin; all actual
HTTP requests are refused. No credentials or human repository is used.

Require `evidence/read-checkout.json` to show:

- The first poll creates a standalone clone at
  `<data dir>/worktrees/synthetic/neo-read-proof/neo-read`, detached at the real
  origin's initial `main` SHA.
- A real commit and push advance the origin's default branch. The second poll
  advances the same clone to that SHA and its `origin/main`; reading `answer.txt`
  there returns `version two`. Git status is clean.
- The synthetic human checkout retains identical HEAD, `origin/main`, uncommitted
  file bytes and dirty status across both polls. No fetch or checkout runs there.
- Both polls complete without an accessibility error. Inspect the API request log
  in `evidence/requests.jsonl` and the cursor's partial-error field too.

At reproduction commit before the production fix, `verify` fails with
`poll did not create Neo read checkout`; `before` records both completed polls,
the real origin movement and the absent read checkout. Commit the failing probe
before the fix. The daemon and WebSocket close in `finally`; keep all synthetic
repositories and evidence.

The production poller calls this sync in its existing cycle, after event polling,
using the same GitHub fetch adapter and quota reserve. It reads default-branch
metadata and its ref; unchanged heads skip Git. First setup clones independently
of human Git metadata. Changed heads run fixed-argv `git fetch origin` and
`git checkout --detach origin/<default>` only: no pull, force, reset or clean.
Refresh failures appear in the existing partial-poll error. No timer was added.
Neo's coding instructions name the same shared path helper's layout.

This proof covers a real local Git default-branch move and production RPC wiring;
it does not run a model turn or claim a real GitHub branch moved. After merge,
read `hyperneo build` over the owner socket to confirm automatic deployment, then
record one naturally occurring real GitHub default-branch advance: compare the
owned read clone's HEAD and file bytes before/after the normal poll with GitHub's
default ref. Do not manufacture a live poll or mutate/fetch the human checkout.
