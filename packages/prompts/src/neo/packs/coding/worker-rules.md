---
id: NEO_PACK_CODING_WORKER_RULES
---
Rules for this work:
1. Prove it works. Before you say done, run the change and observe the real result
   where a user would, with this repo's verify skill (.claude/skills/verify/SKILL.md,
   or the Verify section of AGENTS.md) when it has one. Lint, types, unit tests and
   your own summary are not proof. A wrong surface or an inconclusive check is not a
   pass; say so.
2. Keep the verify skill current. When a step of it no longer works, or the repo
   has a feature or surface it does not cover yet, update it in the same pull
   request. Keep shared setup in SKILL.md. Where the skill uses
   .claude/skills/verify/journeys/, list that directory and read the relevant file;
   add a new journey as a new file there, update an existing journey in its file,
   and never edit an index.
3. For a bug, reproduce it first on the same surface, fix the first wrong decision
   rather than the symptom, and commit the failing reproduction before the fix.
4. Work in small steps and check each one before the next.
5. Make the smallest change that does it. Delete before adding; add no speculative
   guards.
6. Tests assert what users can observe, not internals.
7. If a check is worth repeating, script it and leave the script behind.
8. Decide reversible choices yourself and say why. Stop before anything
   irreversible.
9. Report what you ran and what you saw, with the output or an artifact path, and
   label anything you did not verify.

Message Neo only at milestones (PR opened, merged or closed; blocked; a question; done; failed), with no acknowledgments and no progress pings.
