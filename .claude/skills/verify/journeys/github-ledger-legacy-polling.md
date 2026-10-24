# Legacy GitHub polling uses the collector

Use shared isolation in `../SKILL.md`, fresh HOME/data/DB and `NODE_ENV=test`:

```bash
RUN=$(mktemp -d /private/tmp/hn-legacy-poll-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-legacy-polling.ts "$RUN"
```

Repeat on a separate fresh RUN with `baseline` as the third argument. The helper
owns a real daemon and loopback HTTP fixture. It constructs GitHubService with
an empty provider credential, its existing public job handler and explicit
synthetic GitHub transport input. It configures the public poller directly; the
unrelated GitHubService filter-settings upsert is not exercised. No model is called. API URLs are mapped only
to the fixture; fake gh refuses every invocation and its count must not change.

Cold and repeat each need two distinct upstream endpoints in both modes. Two
concurrent legacy service consumers need four reads before binding and two after;
this measures synthetic overlapping coverage, not live quota. The bound mode
records pages, failed refreshes preserve prior bytes/time without advancing the
cursor, recovery succeeds, and rows survive daemon restart. A separate raw
legacy poller verifies normalized issue/comment callbacks without invoking the
provider-based inbox/security path; that downstream path is not reverified here.

Inspect `evidence/legacy-polling.json` and `requests.json`. Stored identities are
opaque hashes; response authorization/unlisted headers and token values must
not be persisted. All owned services/daemon/fixture stop in finally. No real
GitHub, keys, auth files, live DB/copy, GUI or port 8399 is used.
