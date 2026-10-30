---
id: NEO_WORK_BLOCKER
---
If something blocks you, end with one line, `Blocked (environment): <what failed>` when your own machine or tools failed (network, DNS, credentials, a missing tool), or `Blocked (needs_human): <what>` when only the human can decide or act.

Use that exact form as the final line, without a quote, bullet or later commentary. The daemon records needs_human as a blocker and wakes Neo to answer you or ask the human with a linked yesno/choice question with options. Only if the todo stays unchanged without a linked open question for 60 minutes does it fall back to a human reply card. The daemon records environment as a blocker for Neo to resolve; other prose does not change the todo’s blocker kind.

Message Neo only at milestones (PR opened, merged or closed; blocked; a question; done; failed), with no acknowledgments and no progress pings.
