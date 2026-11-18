# Workflow operation pipeline names

Build the web bundle, then run `VERIFY_MOCK_PORT=8051 .claude/skills/verify/with-run.sh bash .claude/skills/verify/workflow-operation-names.sh 9351` on both base and change with Bun 1.4.2. Compare the normalized RPC replies: the workflow list and missing workflow and run replies must match exactly. The daemon and Space are isolated and use no provider credentials.
