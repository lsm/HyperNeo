# Issue todo PR owners reach their workers

Read the shared setup in `../SKILL.md`. This metadata-only helper owns an
ephemeral isolated daemon, fresh synthetic DB and refusing GitHub executable.
It needs no provider, model mock, browser, credentials or installation.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/coding-issue-pr-owners.ts
```

Run only when local resource restrictions permit daemon verification. The shared
wrapper checks disk space, preserves evidence and removes its temporary data.

Two active `coding.issue_closed` todos have worker sessions. One PR body closes
the mixed-case issue reference; the other is recorded as opened by its worker,
despite an empty attached-PR list and a renamed repository remote. A third PR
only mentions the issue and must stay unowned. The actual ledger GitHub query
runs against a script that projects away `body` if it was not requested.

Observe `issue-pr-owners.json`: both owned PRs move from `approved_pending` to
`approved_green`. A rejected mailbox write leaves durable delivery intent.
After reopening the app, each worker's actual mailbox accepts exactly one ready
event; another sweep adds nothing, `told_at` is populated, and the issue todo
remains doing. A public `neo.todo.add` attempt to duplicate the issue-owned PR
must refuse it and advise continuing that todo, without suggesting `addUrls`,
which only supports PR-merge checks. The public Neo snapshot, ledger, mailbox payloads and synthetic
GitHub request arguments are saved. Before the fix, the closing PR lacks an
owner; the focused regression separately isolates hidden opening evidence.

A later report names another PR without a closing reference. Repeated discovery
of the issue-closing PR must preserve that reported PR's owner, its duplicate
refusal, and exactly one ready event. Its owner must survive the issue todo
settling, without needing another worker report to restore a deleted claim.

This proves mailbox acceptance and application reopen, not model consumption,
OS process restart, live quota behavior or deployed delivery. No live daemon,
real DB, human configuration, port 8399 or network request is used. The helper
closes its socket and daemon in `finally`.
