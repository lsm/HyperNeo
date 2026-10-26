# Neo owns its home

Read shared SKILL.md setup first. This metadata-only helper starts and stops its
own fresh test daemon, empty HOME and database on a free non-live port. It needs
no provider, credentials, HTTP model mock or web build.

```bash
bash .claude/skills/verify/neo-home-ownership.sh "$RUN" ownership 9431
```

Before the fix, run `ownership-before` against the tests-first commit. It must
record the actual dirty refusal with an untracked `evidence/run.json` in home.
After the fix, `ownership` must save through the public operation RPC, commit the
exact document and preserve the untracked evidence without adding it to git.
Inspect `evidence/neo-home-ownership.json` for the reply, commit and bytes.
Save that evidence outside the run directory and immediately remove the run.

The SDK sandbox journey `neo-read-sandbox.md` additionally checks that Neo's
actual Bash can write its home worktree while .git metadata, worker siblings and daemon data stay denied. In particular, it must not plant Git filter drivers or hooks for the daemon to execute. Commits use neo.home.save; preserving .git integrity is the human-authorized exception to home ownership.
Human confirmation on mandate/direction saves remains an approval receipt, not
a filesystem write restriction on documents. Ordinary document edits need no
questionId; sandboxed Bash cannot repair Git metadata. Remote Git publication through RPC retains its lease against replacing history.
