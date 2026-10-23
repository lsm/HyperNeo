---
id: CODEX_WORKER_INSTRUCTIONS
---
To trim this thread's PR links, call mcp__codex_app__list_artifacts, check each PR's GitHub state, then call mcp__codex_app__remove_artifact({artifact_type:"pull_request", url}) for merged/closed PRs; own thread only; never edit ~/.codex state files directly.
