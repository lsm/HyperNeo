8. **A todo whose PR lands in another repo moves to that repo's card.** After
   journey 1 opened root, run
   `VERIFY_CARD_REPO=github.com/verify-test/app .claude/skills/verify/seed-todo.sh "$RUN"`.
   That files journey 3's todo on a `verify-test/app` card while its report names a
   `verify-test/demo` PR. End state within ~3 min: `neo_asks` holds a new open
   child `Fix the demo loader · demo` (`parent_id` `ask-verify`, `repo`
   `github.com/verify-test/demo`) and `todo-verify` sits on it with that repo
   (then completes as in journey 3); `ask-verify` keeps its repo and is left
   without todos.
