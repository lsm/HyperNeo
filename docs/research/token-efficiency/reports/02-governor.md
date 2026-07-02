# 02 — Governor

**Resource:** https://github.com/0xhimanshu/governor  
**Local repo:** `~/focus/tmp/token-efficiency/repos/governor`  
**Type:** Claude Code plugin  
**Focus:** hook-based output filtering, compact response policy, memory compression, token ledger

## Architecture

Governor is a Claude Code plugin built around one Python helper, `scripts/governor.py`, plus thin shell entrypoints in `bin/governor` and `bin/governor-statusline`. Plugin metadata lives in `.claude-plugin/plugin.json` and wires three surfaces: skills, slash commands, and hooks.

The design is mostly deterministic and local. Claude Code hooks invoke Python commands, which inspect hook payloads, decide whether to inject compact context or rewrite noisy tool output, and append telemetry to a JSONL ledger. Model involvement is opt-in for semantic tasks such as compressing memory files or generating planning contracts.

This separation is useful: cheap deterministic filtering handles logs and repeated tool noise, while risky semantic rewriting is gated and auditable.

## Key mechanisms

Governor has four main mechanisms:

1. **Always-on compact mode.** `SessionStart` and `UserPromptSubmit` hooks inject concise response guidance unless Governor is off or Caveman is detected.
2. **Tool-output filtering.** `PostToolUse` and `PostToolUseFailure` detect large/noisy Bash, search, web, task, and MCP-style tool responses, summarize them, and replace raw output with compact signal-preserving summaries.
3. **Memory compression.** `/governor:compress` marks protected spans, asks the model to rewrite non-protected prose, validates preservation, attempts recovery, and restores backups on failure or weak savings.
4. **Governance commands.** `/governor:plan`, `/governor:guard`, `/governor:audit`, `/governor:status`, and `/governor:benchmark` support planning, scope discipline, telemetry, and benchmark evaluation.

Governor explicitly blocklists source reads, edits, writes, notebooks, todo updates, and selected browser-evaluation outputs from rewriting. That avoids corrupting high-fidelity artifacts.

## Token-saving techniques

Governor attacks several token sinks:

- **Final-answer compactness:** injected guidance removes filler, restatement, caveat padding, and process narration.
- **Tool-output clipping:** large logs are reduced to high-priority errors, important structured keys, and head/tail excerpts.
- **Memory compression:** repeated context files such as `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/rules`, and editor rules can be compressed while preserving protected spans.
- **Prompt-risk nudges:** broad prompts trigger soft suggestions to plan or narrow scope, reducing churn.
- **Planning contracts and drift guards:** commands aim to reduce rework and scope drift.
- **Telemetry accounting:** Governor estimates direct savings, overhead injected, and net savings. It distinguishes prompt-cache billing effects from actual context occupancy.

## Claude Code integration

Integration is plugin-native:

- `.claude-plugin/plugin.json` declares plugin metadata and bundled skills/commands/hooks.
- `hooks/hooks.json` registers `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, and `PreCompact`.
- `install.sh` copies the repo into `~/.claude/plugins/marketplaces/governor`, runs `claude plugin marketplace add`, installs `governor@governor`, and can configure the statusline in `settings.json`.
- Slash-command definitions live under `commands/`.
- `skills/usage-governor/SKILL.md` provides behavioral policy for token efficiency, compression, planning, and tool filtering.
- No MCP server is implemented. Governor handles MCP-like output through generic tool-name matching.

Governor also ships portable rule snippets for Codex, Gemini, Cursor, Windsurf, and Cline, but Claude Code hooks are the main enforcement layer.

## Effectiveness claims

Governor’s README is cautious and labels results directional.

Reported pilot:

- Output tokens: **10,997 → 10,113**
- Cost: **$0.5169 → $0.4933**
- One extra turn
- Sample size: **n=1**

Microbenchmarks:

- No-tool prompt output savings: **55.5%** across three prompts.
- Memory compression: **1,877 → 838 tokens**, **55.4% saved**.
- Synthetic pytest filtering: **54,314 estimated tokens → 1,726**, **96.8% blocked**.

V2 fixture benchmark in `benchmarks/sonnet-v2-report.md` emphasizes **valid context loss rate (VCLR)**, not only raw savings. Reported average savings: **45.5%**, VCLR near zero, **100% decision preservation**, and **0% wrong decisions**. Caveman saves more in some fixtures but loses more valid context.

## Stack

Governor is primarily **Python 3**, shell scripts, JSON hook manifests, and Markdown commands/skills. Core runtime has no heavy dependency chain. Benchmarks are Python-based with JSON fixtures and markdown/CSV output.

## Limitations

- Token counts are approximate, based on simple heuristics.
- Hook behavior depends on Claude Code plugin/hook support.
- Compression of memory files sends content through the active model flow, which is risky for sensitive material.
- Benchmarks are small and mostly local.
- Filtering may hide clues, though `/governor:full` is an escape hatch.
- Source reads are intentionally not compressed, limiting savings in code-heavy tasks.

## Actionable takeaways for HyperNeo

1. **Add pre/post tool middleware.** HyperNeo’s agent runtime should support output replacement before transcript injection.
2. **Track net token savings.** Store raw bytes, returned bytes, overhead, direct savings, and “blocked token” estimates per tool call.
3. **Preserve safety blocklists.** Never compress active source reads, edit diffs, write payloads, or user-facing terminal actions by default.
4. **Use VCLR-like quality metrics.** Compression success should mean “needed signals preserved,” not maximum shrinkage.
5. **Compress persistent context with backups.** Agent custom prompts, Space instructions, workflow instructions, and memory files need protected spans plus validation.
6. **Expose status to users.** A Space-level token ledger could show savings by agent, tool, workflow run, and compaction.

## Bottom line

Governor is best viewed as a governance and filtering layer. Its biggest lesson for HyperNeo: token saving needs quality-preserving policy, telemetry, and explicit escape hatches, not blind summarization.
