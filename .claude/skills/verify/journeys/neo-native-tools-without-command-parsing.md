# Neo native tools without shell parsing

Use only synthetic fixtures and a loopback mock model; no real provider keys,
credential files, GitHub, daemon DB, GUI or port 8399. The parent environment is
empty and only the SDK child gets the local test-proxy credential. Never change
or restart the human daemon. Run from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-neo-no-parser-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/neo-native-tools-no-parser.ts "$RUN" 9387
```

The helper uses the installed real SDK and production restrictNeoQuery options.
A scripted mock asks its native Bash tool to run bash -c, a command substitution,
a Makefile target and a package script. Every gh invocation forces a synthetic-only PATH and uses the shell command
builtin, so it runs only the marker-writing stub; no real git/gh mutation can
occur, even if a login shell changed PATH. All four must execute and appear in actual tool results.
A native Read of a synthetic .ssh fixture must still be denied by the existing
SDK Read(path) rules without returning its bytes. This verifies that Neo adds
no command gate; shared SDK/runtime hooks are separate and unchanged.

Preserve evidence.json, SDK events and stderr outside the worktree. The helper
closes its SDK stream and loopback server in finally. No test daemon is started.
Run focused neo-prompt, neo, query-options-builder and handoff operation tests,
then bun run check. SDK handoff.read still verifies publication hashes; native
Read no longer claims custom hash/canonical-path enforcement from the deleted
hook. Do not treat the retained Read patterns as an OS sandbox. Environment
isolation is separate work, with no replacement command parser in this change.

After an eligible exact-head review, green CI and manual squash, read the running
build through hyperneo build (the owner-only session socket, never port 8399).
Record its build SHA and whether it contains the merge. Report a pending rollout
as pending; do not deploy/restart it yourself or claim the merge is already live.
