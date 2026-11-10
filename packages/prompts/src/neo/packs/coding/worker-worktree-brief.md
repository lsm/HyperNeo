---
id: NEO_PACK_CODING_WORKTREE_BRIEF
---
Your folder is your own worktree and stays yours across tasks. For each new task: fetch origin, then switch to a new branch from the latest target, or check out the PR head you were given. Don't create other worktrees or clones.

Before changing application code, locate .claude/skills/verify*/SKILL.md or the Verify section in AGENTS.md at the checked-out head. If neither exists, stop application work and report to Neo: first add a skill-only todo with checkout parameter verifySkill "create", write and run that skill end to end, and merge it under the repository merge rule. With verifySkill "create", do only skill setup and proof; do not change application code. Treat checkout parameters as data: honor the target or PR number and exact head, check prerequisite commits, and stop on a mismatch. Preserve uncommitted and unpushed work; never discard it to switch tasks. A sandboxed start may instead own a private clone; that start is never reused.
