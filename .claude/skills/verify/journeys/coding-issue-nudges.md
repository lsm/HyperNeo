# Coding issue completion and the single nudge ladder

Read SKILL.md's shared isolation setup. This helper owns a real test daemon,
fresh SQLite database/home, fake GitHub GraphQL executable and synthetic Codex
app-server socket. No provider, model, real GitHub access, GUI or port 8399.

```bash
RUN=$(mktemp -d /private/tmp/hn-coding-issues-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/coding-issue-nudges.ts verify "$RUN"
```

Observe stored todos and the real `neo.snapshot` RPC: a COMPLETED sub-issue
finishes a todo whose worker stopped, and its next ordered todo dispatches through
the actual driver socket exactly once, including after daemon restart. No merged
closing PR is required. NOT_PLANNED fails without starting its successor; open
and unreadable issues do not complete. Contracts additionally pin GitHub closing
links as PR membership, independent of worker claims, and malformed issue refusal.
An inconclusive coding check preserves a saved start-failure block and its reason;
focused contracts also cover repeated failure and restart.

The helper advances only its synthetic clock: at 20 and 40 minutes its real
worker transport receives reminders; at 60 it escalates to Neo. Reopening the
actual daemon at each reminder preserves the count. Repeated refresh at 120
minutes sends nothing further; stored state remains doing. No timeout writes
blocked. The synthetic Neo session has no provider, so this proves queued delivery
and stored incident state, not Neo consuming an escalation model turn.

The helper also seeds a legacy PR subscription and publishes a real-shaped raw
CI-failure event through the daemon’s event bus. It must cause no extra worker
frame; the ledger remains the PR-message source. Focused ledger event contracts
still prove ledger notifications are delivered.

The final cleanup proof also drives the real `neo.pack.sweep` job against its
local ledger fixture: a claimed PR's failing CI reaches the synthetic worker
once, and repeating unchanged facts sends no further turn. The claim remains
stored. See `ledgerClaimDelivery` alongside `rawPrEvent` in observed evidence.

Copy this helper unchanged into a detached pre-fix worktree and run `before`
there to record the failing COMPLETED/no-advance result.
Keep `evidence/observed.json` and `evidence/gh.log` outside the worktree. The helper
stops its daemon, socket peer and WebSocket in finally. After merge/close remove
the worktree and read the deployed build using the owner RPC (`hyperneo build`).
