# Evolution operation pipeline names

Build the web bundle, then run `VERIFY_MOCK_PORT=8052 .claude/skills/verify/with-run.sh bash .claude/skills/verify/evolution-operation-names.sh 9352` on base and change with Bun 1.4.4. Compare the normalized RPC replies for empty and populated scope lists, scope creation, and missing scope reads and updates. The isolated daemon uses no provider credentials.
