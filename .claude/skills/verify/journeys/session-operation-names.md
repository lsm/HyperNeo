# Session operation pipeline names

Build the web bundle, then run `VERIFY_MOCK_PORT=8053 .claude/skills/verify/with-run.sh bash .claude/skills/verify/session-operation-names.sh 9353` on base and change with Bun 1.4.4. Compare the normalized RPC replies for the session list and missing session reads, messages, and interruption. The isolated daemon uses no provider credentials.
