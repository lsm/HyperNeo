# Coding-owned read checkout through the GitHub poller

Use the shared metadata-only setup and resource guard in `../SKILL.md`.

```bash
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/neo-read-checkout-sync.ts verify
```

The helper starts an isolated daemon on an ephemeral port, stops its job
processor, seeds a synthetic watched repository and invokes the existing
`space.github.pollOnce` RPC over its authenticated local socket. A GitHub CLI
fixture reads a local bare origin. An isolated HOME Git rewrite redirects only
that synthetic repository to the local origin. All external HTTP is refused.
No model, provider keys, real GitHub repository or human checkout is used.

Require `read-checkout.json` and the wrapper exit status to show all of these.

- The first poll creates a standalone detached clone at the unchanged
  `<data>/worktrees/<owner>/<repo>/neo-read` path and matches the origin SHA.
- A real commit and push advance the origin. The next poll updates the same
  clone and its file bytes. Its Git status stays clean.
- The synthetic human checkout retains its HEAD, remote ref, dirty status and
  uncommitted bytes throughout.
- Repeating the unchanged head adds zero checkout Git commands.
- Replacing the read path with a symlink to the synthetic human checkout and
  advancing the origin again is refused before checkout Git runs. The existing
  `lastPartialPollError` records the standalone-directory refusal.

Inspect `git.jsonl` and `requests.jsonl` for the fixed-argv checkout operations
and GitHub API calls. The resource marker must report `resourcesClosed=true`.
The wrapper saves evidence and removes disposable repositories and daemon data.

The composition regression in `neo-read-checkout-path.test.ts` fails before
extraction because the daemon still imports the core implementation. After the
move, the daemon imports the coding implementation and supplies it through the
same poller callback. Request budget, head cache and checkout path stay intact.

This proves local Git movement and production RPC composition. It uses synthetic
GitHub responses and makes no deployment or live-poll claim.
