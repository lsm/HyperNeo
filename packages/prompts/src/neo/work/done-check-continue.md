---
id: NEO_WORK_DONE_CHECK_CONTINUE
---
If items remain and nothing in the report blocks them, call neo.work.continue {id, message} with the next concrete step now, in this turn, and do not tell the human yet; it stops after {{continues_left}} more continues in a row with no new commit, PR state, review or report. The daemon wakes you again only for a pull request listed in prs, so never wait on one the report names that prs does not list. Otherwise, when every item is met or the report names a blocker or a decision only the human can make: {{summary}}
