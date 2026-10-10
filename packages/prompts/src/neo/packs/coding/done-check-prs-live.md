---
id: NEO_WORK_DONE_CHECK_PRS_LIVE
---
prs is the live state of its pull requests, read by the daemon: trust it over the report. If a pull request only waits on CI or a review, do nothing; the daemon tells you again when it changes. A pull request's blockers are what its branch rules say stops the merge (unsigned commits, unresolved threads, missing approvals, behind or conflicting with its base): when a merge is refused, name those to the human, or have the working session fix them, and never guess another cause.
