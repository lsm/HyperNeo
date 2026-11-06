# A cross-repository request stays on one card

Journey 7 shares the metadata-only MCP proof in
[Journey 8](08-a-todo-whose-pr-lands-in-another-repo-moves-to-that-repo-s-card.md).
Use SKILL.md's guarded wrapper from the worktree root:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/ask-bookkeeping-actions.ts
```

Through the agent-visible operation door, open one request with coding todos
for two repositories. The reply must contain one open ask with both todos on
that ask. No repository child is created and the parent stays open. Read the
same ask through neo.ask.read before and after reopening the database, preserving
both todos and their original ask IDs. The helper also reads historical child
cards independently, so retaining old children does not create new splits.

Keep observed.json and proof.log. The wrapper removes the synthetic database and
HOME after saving evidence. This proof covers MCP and public read results. Web
layout and a model-driven chat turn require separate observation.
