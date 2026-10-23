# Ledger HTTP page response adapter (Build)

Use shared isolation rules in `../SKILL.md`. Metadata is separate from fact
values, so cycle IDs, status and rate/validator headers do not masquerade as
fact changes. Only an additive nullable column is migrated: no existing row,
value_json or revision is rewritten/backfilled. Only etag, last-modified,
retry-after and the explicit x-ratelimit header allow-list are persisted.
Authorization, cookies and unlisted headers never enter stored metadata.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-poll-http-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-poll-http.ts "$RUN"
```

The helper creates a synthetic old-schema DB, then owns an actual isolated
daemon and loopback HTTP fixture on ephemeral ports. Migration/reopen must keep
old rows/raw JSON/revisions unchanged and new metadata NULL. Three sequential
local calls in one cycle make one HTTP request. A later cycle validates with
304, retains known body/rate coverage without a fact change, and exposes a 503
as unknown. Daemon restart retains that failure and recovery preserves the fact
revision. Inspect `evidence/poll-http.json`; no credentials, auth files, real
GitHub, model, GUI, live DB or port 8399 are used. Resources close in finally.

Run `neo-ledger-poll-http`, page-fact/coalescing contracts, merge/summary and
public polling compatibility suites, then full checks. Contracts also cover a
file-backed old-schema migration twice plus reopen, header exclusion, concurrent
CAS, superseded responses and oversized valid JSON remaining partial.

Repeat the unchanged normal/conditional/failure public-RPC polling journey and
retain actual counts against 18 initial / 18 repeat GETs (eight failure, 18
recovery). No production caller uses the adapter yet; the local three-to-one
proof is not an aggregate quota-saving claim. Wire follows in a separate PR,
preserving destination cursors, cutoffs, fairness and existing error visibility.
After merge, verify automatic rollout via owner RPC; never deploy/restart.
