# Ledger polling acquisition coalescing (Build)

Use shared isolation rules in `../SKILL.md`. The ledger's local `pollFacts.acquire`
shares only in-flight GET acquisitions on the same daemon DB, keyed by an opaque
credential label, exact page URL, representation/API version, head/base and
validator. Each caller receives a Response clone. The callback belongs to the
collector transport and retains its existing timeout ownership; this slice
introduces no caller-abort or deadline policy. Completed requests are not cached.
No schema, stored page/history, RPC, permission or production call site changes.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-poll-coalescing-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-poll-coalescing.ts "$RUN"
```

The helper owns an actual isolated daemon and local HTTP fixture on ephemeral
ports. Three callers through separate ledger instances make one real HTTP GET;
all can consume the response independently. A subsequent request acquires again.
503 and 304 status/headers are preserved, and stored page rows remain byte-equal
before/after acquisition and daemon restart. Keep `evidence/coalescing.json`.
Resources close in finally. No model, GUI, credentials, auth files, real GitHub,
live DB or port 8399 is used; direct external HTTP is refused.

Run `neo-ledger-poll-coalescing`, `neo-ledger-poll-facts`, existing ledger summary
and polling compatibility contracts, plus the full repository check. The existing
`github-ledger-polling.ts` normal/conditional/failure public-RPC scenarios must
retain their 18 initial / 18 repeated repository GET baseline (eight on failure,
18 on recovery). Save actual request counts and both destination histories.
The local three-to-one proof is not an aggregate quota-saving claim; active
external-event acquisition is not wired yet. After merge, verify automatic
owner-RPC build ancestry, remove the worktree and unlink the merged PR.
