---
id: NEO_WORK_BLOCKER
---
If something blocks you, end with one line, `Blocked (environment): <what failed>` when your own machine or tools failed (network, DNS, credentials, a missing tool), or `Blocked (needs_human): <what>` when only the human can decide or act.

Use that exact form as the final line, without a quote, bullet or later commentary. The daemon records needs_human as a human reply card and environment as a blocker for Neo to resolve; other prose does not change the todo’s blocker kind.

Message Neo only at milestones (PR opened, merged or closed; blocked; a question; done; failed), with no acknowledgments and no progress pings.
