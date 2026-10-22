# Neo company flow first use (PR 1)

Read shared setup in `../SKILL.md`. Use a fresh synthetic run directory, the
existing Launch helper and `VERIFY_MOCK=neo-script-api.ts`. Preflight the chosen
daemon port and 8000 as Launch requires; never use 8399. Build the web assets
for serving, but no GUI automation is needed.

```bash
RUN=/absolute/fresh/run-dir
VERIFY_MOCK=neo-script-api.ts .claude/skills/verify/launch.sh 9437 "$RUN"
bun .claude/skills/verify/neo-home-save.ts 9437 "$RUN" runtime
bun .claude/skills/verify/neo-home-confirmed-save.ts 9437 "$RUN" after
```

The first actual save RPC runs without an init RPC, with synthetic runtime files
already under Neo/.claude, Neo/.coordinators and Neo/worktrees. Before the fix it
records a dirty refusal in `evidence/neo-home-save.json`. Afterward it creates a
local home and saves exact bytes, leaving runtime files unchanged and untracked.
The confirmed-save journey proves the separate exact-path/SHA human yes gate,
paired decision log and trailer still work, including refusal/rollback cases.
Git identity is synthetic and local; no remote is configured.

Register only the loopback mock provider as in shared setup, then run:

```bash
bun .claude/skills/verify/goal-schedule.ts 9437 "$RUN"
.claude/skills/verify/stop.sh "$RUN"
bash .claude/skills/verify/neo-goal-cycle-sdk.sh /another/fresh/absolute/run-dir
```

The first helper waits for the real one-minute verification cadence, observes
its wake in the actual session transcript and checks goalId/runId, mandate and
full cycle guidance. The production setup guidance explicitly asks for 15
minutes and nudgeEvery1-2; those stored values are covered by the focused goal
operation contract, while runtime defaults stay unchanged. The SDK fixture
captures an ordinary model-facing request: setup guidance is present and the
full cycle is absent from its system prompt. It also retains publication/read
plumbing assertions. SDK evidence does not prove an autonomous model will
choose to start a goal; Neo and the human perform that real run after deployment.

Retain home save/confirmation and goal-schedule JSON, SDK prompt evidence and
focused test output. Run neo-home-save/setup, neo-prompt, neo-goal-cycle-prompt
and goal-session-operations tests; existing sync/read contracts must also pass.
All runs use NODE_ENV=test, isolated HOME/data/DB, fake gh and loopback models;
no live data, credentials, remote GitHub or auth files are used. Stop only owned
services. The SDK wrapper owns and closes its services in finally. Real standing
outcome creation, a physical second machine and GUI presentation are unverified.
