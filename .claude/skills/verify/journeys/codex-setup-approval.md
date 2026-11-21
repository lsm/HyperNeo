## Codex setup approval

On macOS, run with the pinned Bun version and isolated proof wrapper from
`SKILL.md`.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence \
  .claude/skills/verify/codex-setup-approval.ts
```

The proof reads Neo's actual dashboard snapshot and answers its cards through
authenticated RPC. A synthetic Codex installation appears after daemon startup,
then a send triggers the first-use card. The proof restarts the daemon before
answering, checks that decline changes nothing, and exercises startup detection
on a fresh setting. It approves while the managed server is busy and verifies
that the next daemon resumes the approved setup at idle. Finally, it verifies
that the CLI's remote-control skip and undo stay quiet across restart.

The fixture owns the Unix socket, database, home and login-command doubles. No
host launchd setting or Desktop process changes. Retain the proof log and exit
status. The signed design still requires live Desktop, paired-phone and
logout/login verification.
