8. **A todo whose PR lands in another repo stays on its original card.** After
   journey 1 opened root, run
   `VERIFY_CARD_REPO=github.com/verify-test/app .claude/skills/verify/seed-todo.sh "$RUN"`.
   That files journey 3's todo on a `verify-test/app` card while its report names a
   `verify-test/demo` PR. Within ~3 min, no repository child is created.
   `todo-verify` keeps `ask_id = ask-verify` and its
   dependency links, then completes as in journey 3. `ask-verify` remains open
   until explicitly settled. Its recorded repo stays as seeded during this slice.

   The metadata-only MCP variant runs through `ask-bookkeeping-actions.ts` using
   SKILL.md's proof wrapper. A two-repository `neo.ask.open` must return one open
   ask with both todos. Its public reader must preserve that result after database
   reopen, while historical child cards remain readable as independent cards.
