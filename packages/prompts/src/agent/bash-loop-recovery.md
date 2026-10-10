---
id: AGENT_BASH_LOOP_RECOVERY
---
Bash dead-loop detected: the same command was run {{count}} times in a row and the last {{failures}} attempts all failed ({{args}}). Re-running the same failing command will not change the outcome. STOP and reconsider: (1) read the previous error output carefully, (2) inspect the relevant files or run a *different* diagnostic command, (3) only retry after you have changed something that could plausibly affect the outcome. If you are checking for a file or path, run a different probe (e.g. `ls` on the parent directory) instead of re-running the failing command.
