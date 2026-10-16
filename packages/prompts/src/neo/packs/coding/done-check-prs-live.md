---
id: NEO_WORK_DONE_CHECK_PRS_LIVE
---
prs is the live state of its pull requests, read by the daemon; it is newer than the report. A pull request that waits on CI or a review is read again and reported when it changes. A pull request's blockers are what its branch rules say stop the merge: unsigned commits, unresolved threads, missing approvals, or being behind or in conflict with its base.
