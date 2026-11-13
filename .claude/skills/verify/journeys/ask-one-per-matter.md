**A second open ask for the same pull request is refused with the first one's id.**

Use the shared isolated metadata-only setup in SKILL.md. No model, provider,
worker, browser, real GitHub or credential file is used; external HTTP is
disabled. The helper owns its daemon and closes it in finally.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/ask-one-per-matter.ts verify
```

Through the real agent MCP door, as a Neo session, on the daemon's own packs:

- The first `neo.ask.open` names a synthetic pull request by URL and opens.
- A second one with another title names the same pull request as `owner/repo#n`.
  It is refused with `ask_open`, the first ask's title and id, and no ask is added.
- A retry with the first title returns the first ask.
- An ask for another pull request and an ask that names none both open.
- After `neo.ask.settle` on the first ask, the refused ask opens.
- In a project bound to the synthetic repository, asks that write the same pull
  request as `PR #n`, `repo#n` or `Repo#n` are refused with the first ask's id.
  `#n` in an ask with no project, and another number in the project, both open.

Evidence is `observed.json` and `proof.log`. This proves the refusal at the
operation, not how Neo words its next turn.
