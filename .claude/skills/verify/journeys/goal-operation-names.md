# Goal operation pipeline names

Build the web bundle, then run `VERIFY_MOCK_PORT=8048 .claude/skills/verify/with-run.sh .claude/skills/verify/goal-operation-names.sh 9348` on both base and change. Compare the JSON replies: goal creation must succeed and a missing goal must return `goal_not_found` unchanged. The script uses an isolated daemon and synthetic Space.
