# Full core/pack import boundary (step 6b2)

This extraction moves GitHub project operations and merge-goal guidance into
the coding pack, and generic preference operations into core. Core imports no
pack implementation. Obsolete-path deletion remains a separate step 6c.

Run `bun run check:neo-pack-imports` on the characterization commit before the
moves: it must fail and name the four remaining core imports. On the final head
it must pass, both directly and inside `bun run check`.

Follow SKILL.md's shared isolation setup and the commands in
`todo-plan-recompute.md`, `coding-issue-nudges.md` and
`core-pack-preferences-slice-1.md`, with a fresh RUN for each helper. Run the plan
helper with `--lifecycle` before and after extraction. Compare its
`evidence/observed.json`: states, dispatch counts and retained report hashes must
match, as must the complete `turn/start` input messages captured by the synthetic
Codex peer. Compare the GitHub stub request multiset; unchanged counts demonstrate
no acquisition change, not a live quota reduction.

Repeat the plan helper with `--lifecycle --without-coding`: only inbox-triage is
enabled. All worker input messages must still match the coding-enabled run;
the runner uses installed packs, so merge guidance is independent of enablement.

On the final head, observe COMPLETED advancing exactly once, NOT_PLANNED failing,
open/unreadable issues waiting, restart preserving the 20/40/60 ladder without
blocking, and no raw-PR-event worker message. The preference helper must retain
the human setting and provenance through restart without applying defaults.
Run the affected project authorization, preference, driver-goal, legacy claim,
todo-runner and daemon-commit contracts as well as the full repository check.

Keep helper logs and observed JSON outside the worktree, labelled with the exact
head. Helpers close their owned daemons and listeners in finally. No real HOME,
DB, credentials, GitHub, model, GUI or port 8399 is used. This proves daemon RPC,
persisted state and worker transport behavior; it makes no browser-render claim.
After merge record owner-RPC build ancestry, remove the worktree and unlink the
merged PR attachment.
