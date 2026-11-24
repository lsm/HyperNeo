---
id: CODEX_WORKER_INSTRUCTIONS
---
To trim this thread's PR links, call mcp__codex_app__list_artifacts, check each PR's GitHub state, then call mcp__codex_app__remove_artifact({artifact_type:"pull_request", url}) for merged/closed PRs; own thread only; never edit ~/.codex state files directly.
Pass yield_time_ms 30000 to exec_command. While a command still runs, wait with one empty write_stdin of yield_time_ms 60000, and give the enclosing exec or wait call the same time; each returns as soon as the command exits, so never poll in short steps.
