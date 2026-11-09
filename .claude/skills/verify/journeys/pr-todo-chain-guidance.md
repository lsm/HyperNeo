# Multi-PR todo chain guidance

Run the shared isolated metadata-only wrapper with Bun 1.4.2:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/pr-todo-chain-guidance.ts
```

The real daemon registry exposes one-PR-per-todo guidance in add and edit.
The MCP neo.pack.read door returns the coding guidance and its example.
Two coding pr_merged todos begin with empty params and receive distinct PR URLs
through neo.todo.edit addUrls, retaining the second todo's after dependency. No worker is started, and deliveryInputs stays zero. This verifies
delivered guidance and the existing stored chain, not model compliance or merge
event routing. The wrapper saves replies and removes synthetic daemon data.
