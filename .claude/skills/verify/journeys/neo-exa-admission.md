# Neo admits the attached Exa tools

Follow the shared isolation and resource-check setup in SKILL.md. Run with the
pinned Bun from the worktree root, saving each run in a fresh evidence directory.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-exa-admission.ts
```

The helper owns an isolated test daemon and scripted model on ephemeral ports,
with disposable HOME/DB and stopped jobs. It persists a Neo coordinator using
DeepSeek, enables Exa with a synthetic DB-only credential, and builds its actual
SDK options. It asserts the Exa server is attached, built-in web tools are hidden,
and permissionMode stays dontAsk. The native SDK then receives a scripted
mcp__exa__web_search_exa call against a local SDK MCP fixture. Only that fixture
replaces the external Exa server. The synthetic model endpoint stays loopback.

Inspect exa-admission.json and sdk-events.jsonl. The fixed run must execute the
fixture once, return LOCAL_EXA_SEARCH_RESULT to the model, and report zero
permission denials. On the pre-fix tree, --baseline must execute nothing and
record the native SDK's permission denial for the same tool. Retain both runs.

This verifies resolved SDK permission admission and coordinator query options.
External Exa search results and a real DeepSeek model response remain unverified.
The helper closes its SDK query, daemon and model listener in finally. The shared
wrapper saves evidence and removes its disposable HOME and database.
