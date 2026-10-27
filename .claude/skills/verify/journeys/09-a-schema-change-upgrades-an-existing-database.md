9. **A schema change upgrades an existing database.** For a PR that adds a
   migration, check out `origin/dev` in its own worktree (`bun install
   --frozen-lockfile` there), then run
   `.claude/skills/verify/upgrade-check.sh <dev-checkout> <port> [run-dir]`. It
   starts the dev daemon on a fresh run dir, then this branch twice on the same
   database, waiting for each to release the DB lock, and prints the legacy Neo
   table count and newest migration marker after each start. End state: the
   branch's marker is applied on the first upgraded start, and a restart changes
   nothing.

For the card search index, use `card-search-upgrade.md`. Its helper reuses one
clean owned checkout and restores its branch after three real daemon starts.
Do not create a baseline worktree solely for a comparison; shared SKILL.md owns
resource and disposable-data setup. The legacy upgrade-check.sh is only for an
already available second checkout.
