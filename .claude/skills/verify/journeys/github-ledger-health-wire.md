# Reconciliation records durable coverage health

Use shared isolation in `../SKILL.md`:

```bash
RUN=$(mktemp -d /private/tmp/hn-health-wire-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-health-wire.ts "$RUN"
```

The helper starts an isolated daemon and runs the existing reconciliation entry
through its real default reader and DB gateway. Its local gh stub emits complete,
invalid REST coverage, rate-limited (Retry-After) and empty responses. Three invalid cycles
raise a persisted incident without altering PR facts. An attempted rate failure
records its deadline and account/resource scope; a tail using the same account
and core resource records cooldown without an added miss. Unrelated accounts
and resources continue. The fixture supplies the non-secret authenticated user
and response resource header instead of assuming a shared credential.
After restart, a cooldown cycle makes zero reads; expiration resumes the same
order and complete empty coverage recovers. Protected polling history is unchanged.

Inspect `evidence/health-wire.json` and `requests.jsonl`; unit contracts also cover
unreached tails without reset evidence, duplicate cycles and invalid/expired reset.
No real GitHub, keys, credential files, live DB/copy, GUI or port 8399.
Neo concern/wake delivery stays separate. The fixture covers REST discovery
and selective GraphQL hydration.
All owned daemon resources stop in finally. This is synthetic evidence, not a
claim of measured live-quota savings.
