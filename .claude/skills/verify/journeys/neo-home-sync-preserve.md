# Home reads preserve ignored and untracked human files

Run from the worktree root. Every invocation needs a fresh `/private/tmp/` directory:

```bash
bash .claude/skills/verify/neo-home-sync-preserve.sh /private/tmp/home-preserve-conflict conflict verify
bash .claude/skills/verify/neo-home-sync-preserve.sh /private/tmp/home-preserve-ff fast-forward verify
bash .claude/skills/verify/neo-home-sync-preserve.sh /private/tmp/home-preserve-exclude info-exclude verify
bash .claude/skills/verify/neo-home-sync-preserve.sh /private/tmp/home-preserve-directory directory verify
bash .claude/skills/verify/neo-home-sync-preserve.sh /private/tmp/home-preserve-fetch ignored-race verify
bash .claude/skills/verify/neo-home-sync-preserve.sh /private/tmp/home-preserve-untracked untracked-race verify
bash .claude/skills/verify/neo-home-sync-preserve.sh /private/tmp/home-preserve-conflict-race conflict-race verify
bash .claude/skills/verify/neo-home-sync-preserve.sh /private/tmp/home-preserve-publish publish-ignored-race verify
bash .claude/skills/verify/neo-home-sync-preserve.sh /private/tmp/home-preserve-publish-untracked publish-untracked-race verify
bash .claude/skills/verify/neo-home-sync-preserve.sh /private/tmp/home-preserve-publish-tracked publish-tracked-race verify
bash .claude/skills/verify/neo-home-sync-preserve.sh /private/tmp/home-preserve-healthy healthy verify
bash .claude/skills/verify/neo-home-sync-preserve.sh /private/tmp/home-preserve-history diverged verify
bash .claude/skills/verify/neo-home-sync-preserve.sh /private/tmp/home-preserve-empty-history diverged-same-tree verify
```

The runner starts from `env -i`, with NODE_ENV=test, an isolated HOME, Git identity,
data directory, empty DB and daemon on an ephemeral loopback port other than 8399.
It creates a bare origin and two synthetic clones. No provider, credentials, real
home, real remote, GUI or command-line safety policy is involved. The Git shim
delegates to real Git; its publication barrier is fixture instrumentation only.

Through the real `operation.invoke` WebSocket door, initialize home and read
`direction.md` after the peer adds a tracked file colliding with an 8,215-byte
binary human result. Test tracked ignore rules, the exact `.git/info/exclude`
mechanism from the reported incident, and an origin file replacing an ignored
directory. Divergent tracked direction changes must produce a conflict question.
Inspect immediately after the read, before answering or saving anything.

The fetch races write human bytes while the fetch transport waits. Publication
races wait until the final merge command, after the application's last clean
check, then introduce ignored, untracked or tracked human bytes. Enable
`merge.autoStash=true` in those fixtures: sync must explicitly refuse to stash late
human edits. The result must refuse, retain every human byte, and leave original
HEAD, HEAD reflog and remote HEAD unchanged. Refusal must never abort or reset the
original home. The healthy case must still read the peer update and retain an
unrelated ignored result.

Nonconflicting divergent histories (including different commits with identical
trees) must refuse without changing the original HEAD/reflog and return a human
question through the existing conflict channel. The full-version document names
both original commit IDs and preserves complete differing file versions. Answering
or applying that question is outside this journey. The pre-fix `diverged reproduce`
case records the safe refusal with no question; fixed `verify` requires a question.

`evidence/neo-home-sync-preserve.json` retains the actual RPC reply, complete bytes
as base64, SHA-256, local HEADs, reflog comparison and remote-HEAD comparison, even
when an assertion fails. The helper closes its own socket and daemon in `finally`.
No unit suite is run by this journey. The existing read-sync journey separately
checks the once-per-wake cache through RPC and the real MCP server.

At tests-first commit `95a33b778a`, use `conflict reproduce` in the original TS
helper with the same isolated environment to observe a missing human file after
the read. Before the explicit no-autostash fix, the tracked-publication fixture
also fails by allowing a late tracked edit to be stashed during publication.

Not verified: GUI, real network authentication, power-loss/filesystem corruption,
or applying a recorded conflict answer (#7989). Non-fast-forward publication
refuses rather than rewriting the original branch history; reconcile that history
with the human. There is no destructive rollback of the original home.
