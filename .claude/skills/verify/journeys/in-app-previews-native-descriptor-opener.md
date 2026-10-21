# In-app previews: native descriptor opener (slice 4)

Run `preview-safe-open.test.ts` with the daemon Vitest runner. It launches a fresh
Bun process to exercise actual libc `openat`, not a mocked filesystem. It requires
exact binary bytes, no-follow root/parent/final opens, single-link regular files,
nonblocking FIFO refusal, callback cleanup, and repeated descriptor-count checks.
A separate process swaps a parent directory with an outside symlink during 1,000
opens: every success must read the original bytes, never its synthetic sentinel.
The CI Node runner also asserts `safe_open_unavailable` without calling a consumer.
Run existing `acp-safe-fs.test.ts` under Bun to retain its original read/write API.

For retained native evidence from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-preview-open-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test bun .claude/skills/verify/preview-safe-open.ts "$RUN"
```

`safe-open-evidence.json` records runtime/platform, successes and refusals. Keep
its synthetic fixtures. Repeat the existing isolated daemon capture/restart and
headless Markdown component journeys for compatibility. The descriptor callback
is internal and does not grant artifact access. There is no path-reader fallback;
raw source registration stays unwired until complete hash capture and authorized
registry receipts exist (slices 5–7). This slice reuses the Bun native ACP backend
on macOS/Linux. No successful Deno/native Windows opener is claimed: an unavailable
backend returns `safe_open_unavailable`, and no source consumer runs. A backend
must independently pass these same proofs before enabling it on another runtime.
No live DB, provider, credentials, source mutation or unattended GUI is involved;
rename/symlink races operate only on newly created synthetic fixtures.
