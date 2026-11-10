---
id: neo.session.archive
---
Archive a session by its work.find ref through its driver, through the human caller or a bound Neo session. Refuses sessions a doing todo is working in, running or waiting turns, unsupported drivers and unreadable state. Preserves the conversation. archived false means it was already archived. Managed clean/pushed worktrees are removed after archiving; the optional worktree receipt reports removal or retention with its reason. Changed, unpushed or unverifiable worktrees are kept. An attached daemon must also support this operation.
