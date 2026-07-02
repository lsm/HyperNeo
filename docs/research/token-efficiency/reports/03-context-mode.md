# 03 — Context Mode

**Resource:** https://mksg.lu/blog/context-mode and https://github.com/mksglu/claude-context-mode  
**Local repo:** `~/focus/tmp/token-efficiency/repos/context-mode`  
**Type:** MCP server + Claude Code plugin/hooks  
**Focus:** sandboxed output processing, local indexing, batch execution, tool-routing enforcement

## Core thesis

Context Mode argues that context waste is caused not only by tool definitions but by raw tool outputs entering the conversation. Logs, Playwright snapshots, GitHub issue lists, CSVs, and API responses can consume tens of kilobytes each. The solution is to move high-volume processing outside model context: the model writes small analysis programs, the MCP server runs them in a sandbox, and only stdout or targeted search snippets return to the transcript.

The article’s headline claim: **315 KB becomes 5.4 KB**, roughly **98% reduction**, extending useful Claude Code sessions from about **30 minutes** to about **3 hours**.

## Repo architecture

The repo is a TypeScript/Node MCP server. Key files:

- `src/server.ts`: MCP tool registration, tool handlers, stats, session/path resolution, security checks.
- `src/executor.ts`: polyglot sandbox executor that writes temp scripts and runs subprocesses.
- `src/store.ts`: SQLite FTS5 content store, chunking, BM25/trigram search, fuzzy correction, snippets.
- `src/session/*`: session event DB, compaction snapshots, analytics, counters.
- `hooks/*`: Claude Code hook scripts and routing logic.
- `src/adapters/*`: adapters for Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Kiro, Pi, OMP, and others.
- `.claude-plugin/plugin.json`: Claude Code plugin manifest.

The article says MIT, but the inspected repo is **Elastic License 2.0**.

## Key mechanisms

Context Mode exposes MCP tools including:

- `ctx_execute`
- `ctx_execute_file`
- `ctx_batch_execute`
- `ctx_index`
- `ctx_search`
- `ctx_fetch_and_index`
- stats, doctor, upgrade, purge, insight tools

`ctx_execute` supports JavaScript, TypeScript, Python, shell, Ruby, Go, Rust, PHP, Perl, R, Elixir, and C#. Bun is preferred for JS/TS when available.

The executor launches isolated subprocesses, captures stdout/stderr, applies byte caps, can background long jobs, and strips dangerous environment variables such as `NODE_OPTIONS`, `PYTHONSTARTUP`, `BASH_ENV`, and compiler injection variables. Authenticated CLIs still work through inherited safe env/config paths.

The knowledge base uses SQLite FTS5. It chunks markdown by headings, preserves code blocks, stores Porter-tokenized and trigram indexes, combines rankings with Reciprocal Rank Fusion, boosts proximity, performs Levenshtein typo correction, and returns snippets around matches instead of whole documents.

## Token-saving techniques

Context Mode’s pattern is “program the analysis, return only the answer.” Instead of pasting 50 KB of logs into context, the model writes a small script to parse logs and print error counts or suspicious rows.

Other techniques:

- **Batch execution:** one call runs multiple commands or searches and prints one concise synthesis.
- **Intent-driven filtering:** large output over about 5 KB can be indexed and searched by intent.
- **FTS retrieval:** load exact chunks only when needed.
- **TTL URL cache:** repeated fetches return cache hints instead of full content.
- **Smart truncation:** preserve head/tail and relevant snippets.
- **Progressive throttling:** repeated search calls are nudged or blocked in favor of batch use.
- **Compact session snapshots:** PreCompact creates capped resume summaries while detailed events remain searchable in SQLite.

## Claude Code integration

Integration is plugin-first:

- `.claude-plugin/plugin.json` registers the MCP server using `node ${CLAUDE_PLUGIN_ROOT}/start.mjs`.
- `hooks/hooks.json` declares `PreToolUse`, `PostToolUse`, `PreCompact`, `SessionStart`, and `UserPromptSubmit` hooks.
- `PreToolUse` intercepts Bash, Read, Grep, WebFetch, Agent, context-mode tools, and external MCP tools.
- High-output patterns such as `curl`, `wget`, inline HTTP, build tools, WebFetch, large reads, and unbounded Bash are blocked or rewritten toward Context Mode tools.
- Bash subagents can be upgraded to general-purpose agents with routing instructions.
- `PostToolUse` captures events; `PreCompact` writes resume snapshots; `SessionStart` injects routing state; `UserPromptSubmit` captures prompts and decisions.
- `configs/claude-code/CLAUDE.md` tells agents to use `ctx_execute` for analysis, avoid raw WebFetch/curl/wget, use `ctx_batch_execute` for gathering, use `ctx_search` for memory, and return file paths instead of inline artifacts.

## Effectiveness claims

Article examples:

- Playwright snapshot: **56 KB → 299 B**
- GitHub issues (20): **59 KB → 1.1 KB**
- Access log (500 requests): **45 KB → 155 B**
- Analytics CSV (500 rows): **85 KB → 222 B**
- Git log (153 commits): **11.6 KB → 107 B**
- Repo research subagent: **986 KB → 62 KB**, **5 calls vs 37**
- Session-level: **315 KB → 5.4 KB**, context remaining after 45 minutes **99% instead of 60%**

Repo `BENCHMARK.md` reports **21 scenarios**, **376 KB raw → 16.5 KB context**, **96% overall savings**. For `ctx_execute_file`: **315 KB → 5.5 KB**, **98% saved**. Knowledge retrieval saves less by design: **60.3 KB → 11 KB**, because exact code examples are preserved.

## Stack

TypeScript targeting Node.js 22.5+, MCP SDK, Zod, esbuild, SQLite via `bun:sqlite`, `node:sqlite`, or `better-sqlite3`, plus browser dashboard assets. Package metadata uses pnpm; install paths use npm/npx.

## Limitations

- Works best on hook-capable platforms; instruction-only platforms rely on model compliance.
- Security can fail open unless configured strictly.
- Operational complexity is high: hooks, platform adapters, SQLite native support, plugin cache repair, and per-platform drift.
- Benchmarks are project-authored fixtures, not independent studies.
- License is Elastic-2.0, not MIT.

## Actionable takeaways for HyperNeo

1. **Add sandboxed batch execution for agents.** Space agents often gather logs, PR state, tests, and repo data; much can be processed outside transcript.
2. **Index large artifacts locally.** Store raw outputs in SQLite/artifact store and inject only snippets or result summaries.
3. **Enforce routing in tool dispatch.** Prompt guidance is weaker than pre-tool middleware that can block or redirect high-output calls.
4. **Attach compact resume snapshots.** Space workflow runs should preserve detailed event DB plus small continuation state.
5. **Measure avoided bytes.** Add per-tool savings metrics for MessageHub/AgentSession.
6. **Prefer file-path artifacts.** Large research outputs should be written to files and referenced, not pasted across agents.

## Bottom line

Context Mode offers the strongest output-side token-saving pattern: isolate expensive observation, compute outside context, return compact evidence. HyperNeo can borrow this as runtime middleware plus artifact retrieval for Space workflows.
