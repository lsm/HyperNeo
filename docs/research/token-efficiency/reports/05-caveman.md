# 05 — Caveman

**Resource:** https://github.com/JuliusBrussee/caveman  
**Local repo:** `~/focus/tmp/token-efficiency/repos/caveman`  
**Type:** style-compression skill/plugin/hooks/MCP proxy  
**Focus:** output compression, memory compression, tool-description shrinking, compact subagent contracts

## Architecture

Caveman is a multi-agent compression layer for AI coding assistants. Its core rule is simple: preserve reasoning and technical fidelity, but compress agent-facing prose into terse “caveman” style.

Repo structure:

- `skills/` and `plugins/caveman/skills/`: LLM-facing skill prompts such as `caveman`, `caveman-compress`, `caveman-stats`, and `cavecrew`.
- `src/hooks/`: Claude Code hook scripts for activation, per-turn mode tracking, stats, and statusline.
- `bin/install.js`: unified installer and provider matrix for Claude Code, Codex, Gemini, opencode, OpenClaw, Cursor, Windsurf, Cline, Copilot, and others.
- `src/mcp-servers/caveman-shrink/`: MCP stdio proxy that compresses tool/prompt/resource descriptions.
- `benchmarks/` and `evals/`: token-reduction measurement harnesses.
- `src/rules/`: static always-on snippets for tools without hooks.

Runtime stack is mostly **Node.js** for installers, hooks, and MCP proxy, plus **Python** for memory-file compression validation and benchmarking. Installer requires Node >=18 and has zero runtime npm dependencies.

## Key mechanisms

### Prompt-level compression skill

`skills/caveman/SKILL.md` tells the model to drop articles, filler, pleasantries, and hedging; allow fragments; preserve code and technical terms; and use intensity modes such as `lite`, `full`, `ultra`, and `wenyan-*`.

### Claude Code hooks

`.claude-plugin/plugin.json` registers:

- `SessionStart`: runs `caveman-activate.js`
- `UserPromptSubmit`: runs `caveman-mode-tracker.js`

`caveman-activate.js` writes `$CLAUDE_CONFIG_DIR/.caveman-active` and emits hidden session rules. `caveman-mode-tracker.js` parses `/caveman` commands and natural-language activation/deactivation, updates state, and injects small per-turn reinforcement while active.

### Statusline and stats

`caveman-stats.js` reads Claude Code JSONL transcripts, sums real `usage.output_tokens`, estimates savings using benchmark ratios, writes lifetime history, and updates statusline suffixes with saved-token counts.

### Memory compression

`caveman-compress` rewrites natural-language memory files such as `CLAUDE.md` into compact style, while preserving code blocks, inline code, URLs, paths, headings, commands, env vars, proper nouns, and numeric values. It backs up originals as `FILE.original.md`, validates output, and refuses sensitive-looking files.

### MCP shrink proxy

`caveman-shrink` wraps an upstream MCP server and compresses safe prose fields, mainly `description`, in `tools/list`, `prompts/list`, `resources/list`, and resource templates. It does not mutate tool-call requests or responses.

### Cavecrew subagents

`cavecrew` defines terse investigator/builder/reviewer output contracts. Motivation: subagent results are injected into main context verbatim, so structured compressed findings preserve budget.

## Token-saving techniques

Caveman uses surface-area reduction:

- **Output compression:** concise response style reduces generated tokens.
- **Repeated-context compression:** memory files shrink input tokens every session.
- **Tool catalog compression:** MCP tool descriptions shrink context loaded before work starts.
- **Subagent result compression:** delegated work returns compact structured findings instead of verbose prose.
- **Hook reinforcement:** one full ruleset at session start, tiny reminders per turn.
- **Conservative preservation:** code, identifiers, paths, URLs, and exact errors are not shortened.

## Claude Code integration

Integration is deep:

- Plugin install: `claude plugin marketplace add JuliusBrussee/caveman && claude plugin install caveman@caveman`.
- Plugin hooks declared in `.claude-plugin/plugin.json`.
- Standalone installer copies hook files to `$CLAUDE_CONFIG_DIR/hooks/` and merges hooks/statusline into `$CLAUDE_CONFIG_DIR/settings.json`.
- `bin/lib/settings.js` handles JSONC settings, atomic writes, backups, hook-schema validation, and idempotency.
- MCP registration: `claude mcp add caveman-shrink -- npx -y caveman-shrink`.

## Effectiveness claims

README/evals claim:

- About **75% output-token** reduction in product copy.
- Real Claude API benchmark average: **65% output reduction** across 10 prompts, range **22–87%**.
- Example table average: normal **1214** tokens vs caveman **294** tokens.
- `caveman-compress` memory receipts average **46%** reduction.
- Cavecrew claims roughly **60% smaller** subagent outputs than vanilla.
- Stats code uses only `full: 0.65` as measured compression ratio; other modes lack estimates.

The eval harness compares against an `Answer concisely.` control, not only a verbose default. Limitations are documented: no fidelity judging, approximate tokenizer, single-run snapshots, no latency/cost accounting, and skill-prompt input overhead excluded from output-only savings.

## Limitations

- Primary savings are output tokens; reasoning/thinking tokens are untouched.
- Gains depend on output-heavy workflows; small replies can be offset by ruleset overhead.
- Compression can create ambiguity, so Caveman has auto-clarity escapes.
- MCP shrink only compresses metadata, not tool results.
- Benchmarks do not prove correctness preservation.
- Multi-agent/provider support requires brittle installer and adapter maintenance.

## Actionable takeaways for HyperNeo

1. **Add style compression as a session mode.** Space agents could have “concise output” defaults independent of user chat style.
2. **Use lifecycle injection.** Full rules at session start, tiny reminders on each user turn to avoid drift.
3. **Compress preset prompts.** `seed-agents.ts` has verbose reviewer/research prompts; compressing them could save every Space agent session.
4. **Shrink MCP tool descriptions.** HyperNeo already injects runtime MCP servers into Space sessions; tool-description compression would reduce passive context.
5. **Define compact subagent output contracts.** Research→Reviewer and Coder→Reviewer workflows should pass structured receipts, not long transcripts.
6. **Track real usage.** Parse session usage and show savings by Space, task, node, and agent.
7. **Keep clarity escapes.** Security warnings, destructive actions, and ordered procedures should not be over-compressed.

## Bottom line

Caveman is the most lightweight technique family: prompt style, memory compression, metadata shrinking, and compact subagent contracts. HyperNeo can adopt much of this quickly, especially for preset prompts and Space workflow handoffs.
