# GitHub health reaches Neo through the attention entry

Use shared isolation and cleanup in `../SKILL.md`. This proof boots one fresh
synthetic daemon on an ephemeral loopback port with the job processor stopped,
so no model, provider, browser or external HTTP is used; `gh` is the refusing
stub.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/github-ledger-health-delivery.ts
```

The helper binds a synthetic Neo session and uses a controlled clock. Observe
`health-delivery.json` and the `neo_notes` and `mailbox` queues:

- the GitHub polling report (`reportGitHubWatchHealth`, as the daemon wires it,
  with the real Neo service entry): two missed cycles tell nothing; the third is
  one `coding.github_health` digest, not repeated within the day, told once more
  a day later, and never again once polling recovers;
- the real coding pack sweep (`NeoService.sweepPacks`) with one watched
  repository whose GitHub read fails: an approved pull request whose readiness
  read is older than 15 minutes is one digest;
- nothing wakes Neo, and no health row keeps a told record.

This does not show a model consuming the digest flush, or a real GitHub read.
