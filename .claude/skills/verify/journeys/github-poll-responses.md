# Conditional and large GitHub polling responses

Read `../SKILL.md`. This helper owns an isolated daemon, a fresh database and a
fake gh executable. No model, GUI, real GitHub request or credentials are used.
Direct HTTP is refused. The daemon uses an ephemeral loopback port, never 8399.

From the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-poll-responses-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-poll-responses.ts verify "$RUN"
```

The fixture follows two synthetic PRs and invokes the real public `/ws`
`space.github.pollOnce` RPC twice. It seeds persisted ETags for the conditional
repo. Its gh returns complete HTTP 304 headers with exit code 1. The large repo
returns a 100-comment, 1.67 MB page; the next page is empty. Each comment has a
different ID and its full synthetic body. Inspect `evidence/responses.json` and
`evidence/requests.jsonl`:

- Both repositories acquire a successful poll timestamp. HTTP 304 remains a
  not-modified result with its metadata, not an error or a fresh empty document.
- Exactly 100 comments are retained, with every body byte matching the fixture.
  The second poll finishes the existing page continuation, clears its partial
  status and creates no duplicate stored comments.
- Requests still use per_page=100. The fix does not change page offsets, clear
  stored bookmarks, trim history or multiply requests through smaller pages.
- The stdout bound is specific to GitHub responses: 16 MiB instead of the generic
  1 MiB script buffer. The existing stderr bound and request deadline remain.
  Unit contracts also refuse a response exceeding 16 MiB and nonzero exits with
  HTTP 200/302; only a valid 304 is exempted from that incomplete-response check.

At reproduction commit `6266943b23`, use `before` instead of `verify`. The
conditional repo remains unpolled with a complete-response error; the large
page is refused with zero stored comments. Both failures are observed through
the same RPC door before the fix. An earlier fixture without active subscriptions
is inconclusive and is not the reproduction evidence.

The helper stops the job processor before seeding and closes its WebSocket and
daemon in finally. Keep the JSON evidence outside the worktree. Model consumption
and Deno runtime execution are not verified here. This is a transport correction,
not a ledger consolidation or a claim of reduced live API reads. After deployment,
check the build commit and normal scheduled poll timestamps read-only; never
invoke pollOnce on the live daemon or inject an event to manufacture freshness.
