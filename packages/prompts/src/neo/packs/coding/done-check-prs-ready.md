---
id: NEO_WORK_DONE_CHECK_PRS_READY
---
prs is the live state of its pull requests, read by the daemon: one has been approved on its latest commit with passing checks for over 30 minutes, yet it is still open and nothing has moved since. If its done list says merged, continue the working session to merge it (it may need a rebase or have unresolved review threads); if only the human can unblock it, say what they must decide.
