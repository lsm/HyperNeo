## Independent verification journeys merge cleanly

From the worktree root, list `.claude/skills/verify/journeys/`, read this file,
then run:

```bash
python3 .claude/skills/verify/journey-merge-check.py --output /tmp/journey-merges.json
python3 .claude/skills/verify/journey-links-check.py --output /tmp/journey-links.json
```

The helper copies only this skill and its journey files into a temporary Git
repository. It creates two synthetic branches, each adding its own journey,
then runs `git merge-tree --write-tree` in both orders. Both merges must exit 0,
retain both new files byte-for-byte and leave the shared `SKILL.md` unchanged.
The JSON records each merge result. The temporary repository is removed on exit.
The second check follows the standalone recipes' cross-file helper/setup links
and checks that feature designs and the coding pack's exported contributor
prompts direct new recipes to this directory while keeping shared setup in SKILL.md.

On the tests-first reproduction commit, both branches instead append to the
shared skill, matching the old workflow. Both merge orders must conflict in
`SKILL.md`; the helper writes that evidence before failing. No daemon, provider,
credentials, live data, GUI or network is used by this check.

Add future journeys as new files with unique descriptive names in this directory.
Do not edit an index or reserve the next global journey number. Existing helpers
stay in `.claude/skills/verify/`, and their commands still run from the worktree root.
