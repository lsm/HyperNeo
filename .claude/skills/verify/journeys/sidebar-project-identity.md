# Group sidebar checkouts by repository

Build the web bundle at the current head, then run
`.claude/skills/verify/sidebar-project-identity.sh <evidence-dir>`. It owns an isolated
daemon and browser, uses synthetic workspace history, and stops the daemon on exit.
Two checkouts of one repository appear in a single row. A third checkout with the
same basename and a different repository appears separately. The script records
the visible row count and screenshots of the collapsed rows in light and dark
mode. Two checkouts with the same Git history
and no remote also appear together. Removing that row clears both workspace
history entries, and the row stays gone after reload. The remote group stays
collapsed when a checkout with commits joins it. If the grouped history
request times out, all four remaining saved folders appear individually.
