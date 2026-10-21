24. **Projects never merge on their own.** After journey 1 opened root, insert two
   `neo_concerns` rows whose `repo:` aliases in `neo_project_workspaces` name the
   same repository, then call `rpc.ts neo.projects.reorganize '{}'`. End state:
   the reply has no `merged` field, both projects remain, `neo_project_merges` is
   empty, and the `repository:` identity belongs to the older project. To see what
   the cleanup would do on a real daemon without touching it, run
   `bun .claude/skills/verify/cleanup-dry-run.ts [db]` (read-only; defaults to
   `~/.hyperneo/data/daemon.db`): it prints the planned deletes, and any merge it
   lists runs only with `apply: true`. To see an explicit merge carry its asks,
   run `VERIFY_PORT=<port> .claude/skills/verify/merge-check.sh "$RUN"`: it seeds a
   `Web` home with a `repository:` alias and a same-titled copy holding a done ask
   whose todo names another repo, then calls `neo.projects.reorganize {"apply":true}`.
   End state: `neo_project_merges` has `project:web-copy → project:web`, `ask-merge`
   now has `project_id` `project:web`, and `todo-merge` keeps
   `github.com/verify-test/other`.
