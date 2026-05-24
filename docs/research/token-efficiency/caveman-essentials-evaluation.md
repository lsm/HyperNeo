# Caveman essentials evaluation for NeoKai

## Executive summary

Recommendation: implement a NeoKai-native `compressed` output mode as a prompt-only MVP for Space task agents, then measure before adapting Caveman tools.

Do **not** bundle Caveman wholesale. Caveman's highest-value primitive is a small style contract: terse status, no filler, code/identifier preservation, short failures, and normal-prose escape hatches for safety/approval/clarity. Its hooks, installer, statusline, memory compressor, MCP shrink proxy, and branded slash commands solve Claude Code/plugin distribution problems that do not map cleanly to NeoKai's runtime.

Best first integration point: add output-mode prompt injection in `buildCustomAgentSystemPrompt()` or task-message composition in `packages/daemon/src/lib/space/agents/custom-agent.ts`, with persisted config on `SpaceAgent` and optional workflow-slot override later.

Target: 50%+ output-token reduction on representative Space agent outputs without lower review/coding/research quality.

## Evidence reviewed

- Local Caveman plugin installation under `~/.claude/plugins/marketplaces/caveman`.
- Existing NeoKai research note: `docs/research/token-efficiency/reports/05-caveman.md`.
- NeoKai Space agent prompt path:
  - `packages/daemon/src/lib/space/agents/custom-agent.ts`
  - `packages/daemon/src/lib/space/agents/seed-agents.ts`
  - `packages/shared/src/types/space.ts`
- NeoKai token/context usage surfaces:
  - `packages/daemon/src/lib/agent/context-fetcher.ts`
  - `packages/web/src/components/space/thread/space-task-thread-events.ts`
- Caveman upstream repo metadata and README via GitHub.

## Caveman primitives: essential vs non-essential

| Caveman behavior | Token value | Quality risk | NeoKai recommendation |
|---|---:|---:|---|
| Drop filler, pleasantries, hedging | High | Low | Adopt |
| Prefer terse status updates | High in workflows | Low | Adopt |
| Preserve code blocks, identifiers, paths, URLs, exact errors | Quality-preserving | Low | Adopt |
| Short failure reports with exact blocker and next step | High | Low | Adopt |
| Code-first answers where code/diff is primary artifact | Medium | Low | Adopt as guidance |
| Escape hatch for security, irreversible actions, ambiguous multi-step instructions | Quality/safety critical | Low | Adopt |
| Intensity modes (`lite`, `full`, `ultra`, `wenyan-*`) | Medium | Medium | Skip MVP; start binary `normal`/`compressed` |
| Caveman branding/persona | Low | Medium product fit risk | Skip unless exposed intentionally |
| Hook-based per-turn activation/tracking | Medium for Claude Code | Medium maintenance | Skip; NeoKai owns session prompt assembly |
| Statusline and local transcript stats | Medium | Low | Rebuild natively later using NeoKai session usage |
| Memory-file compressor | Medium input-token savings | Medium correctness/safety | Defer; separate feature |
| MCP shrink proxy | Medium passive input savings | Medium protocol/metadata risk | Defer; consider native metadata compaction later |
| Cavecrew subagent contracts | High for multi-agent workflows | Low | Adapt as native workflow output contracts, not as imported agents |
| Commit/review slash commands | Medium | Low | Adapt specific compact output formats where useful |

## Prompt constraints that likely produce most savings

Highest ROI constraints from Caveman:

1. Remove social wrappers and filler.
   - No "Sure", "happy to", "I can", "basically", "just", "really".
2. Require action-first sentence shape.
   - Pattern: `Thing changed/fails. Reason. Next step.`
3. Avoid prose summaries after tool-heavy work unless they add decisions, blockers, or verification result.
4. Prefer bullet receipts over paragraphs.
5. Keep technical nouns intact.
   - Do not abbreviate function names, API names, config keys, file paths, error strings.
6. Preserve code blocks exactly.
7. Use normal prose for safety/approval/clarity cases.

Candidate NeoKai prompt fragment:

```text
## Output style

When outputMode is `compressed`, be terse and action-first.

- Drop filler, pleasantries, hedging, and recap prose.
- Prefer fragments and bullets over paragraphs.
- Report only: result, blocker, changed files, verification, next required action.
- Keep code blocks, identifiers, paths, URLs, commands, and exact errors unchanged.
- Use normal clear prose for security warnings, irreversible actions, approval requests, and multi-step instructions where compression could create ambiguity.
- Do not reduce review thoroughness, test expectations, or tool diligence.
```

This keeps token-saving semantics without Caveman persona or mode complexity.

## Prompt-only vs tools/skills

### MVP: prompt-only

Prompt-only is enough for first adoption because NeoKai already centralizes Space agent behavior in runtime prompt assembly:

- `buildCustomAgentSystemPrompt()` returns behavior prompt from `SpaceAgent.customPrompt` plus slot override.
- `buildCustomAgentTaskMessage()` builds factual task/workflow/space context.
- Preset prompts in `seed-agents.ts` are verbose but controlled data.

A native output-style fragment can be appended after preset/custom prompt, or represented as a dedicated contract block that user prompts cannot override.

Benefits:

- Small implementation.
- No external dependency.
- Easy per-agent/task persistence.
- No plugin/hook compatibility burden.
- Can be A/B tested using existing SDK usage fields.

### Later: adapted native skills/tools

Worth adapting later, in priority order:

1. **Compact review output contract**
   - Reviewer comments can use one-line finding format for internal handoffs.
   - Caveat: GitHub PR review body still needs identity block and clear verdict.
2. **Compact subagent result receipts**
   - Especially Research→Review, Coder→Review, QA→Review handoffs.
   - Return stable fields: `files`, `findings`, `verification`, `blockers`, `next`.
3. **Token-savings report**
   - NeoKai already stores SDK result usage (`input_tokens`/`output_tokens`) and context usage (`apiUsage`, `messageBreakdown`). Build savings dashboard from real session messages, not Claude Code JSONL parsing.
4. **MCP metadata compaction**
   - Potential passive input savings, but should be native and opt-in because MCP descriptions can encode important semantics.
5. **Memory/prompt compression**
   - Treat as separate research. Needs strict preservation and backups.

Do not adapt Caveman's installer/hooks/statusline directly; NeoKai has its own daemon/web runtime and Space task UI.

## Where output mode should live

Recommended order:

1. **Per-agent default** (`SpaceAgent.outputMode?: 'normal' | 'compressed'`)
   - Fits presets: Coder/Research/Reviewer/QA can default compressed in high-efficiency Spaces.
   - Users can edit agent behavior once and reuse across tasks.
2. **Per-task override**
   - Useful for one-off research or debugging where full prose is needed.
   - Should override agent default for task run only.
3. **Per-space default**
   - Useful bulk preference for new agents/tasks.
   - Should not silently rewrite existing agent behavior.
4. **Workflow slot override**
   - Useful for Reviewer slot being compressed while Coder remains normal.
   - Add after agent-level MVP.

Avoid global app-only mode. Token-efficiency preference varies by Space, workflow, and task.

## NeoKai implementation sketch, if approved

Minimal native behavior:

1. Add shared type:

```ts
export type AgentOutputMode = 'normal' | 'compressed';
```

2. Add optional fields:

- `SpaceAgent.outputMode?: AgentOutputMode`
- `CreateSpaceAgentParams.outputMode?: AgentOutputMode | null`
- `UpdateSpaceAgentParams.outputMode?: AgentOutputMode | null`
- later: workflow slot override and task-run override.

3. Add DB column:

```sql
ALTER TABLE space_agents ADD COLUMN output_mode TEXT DEFAULT NULL
  CHECK(output_mode IS NULL OR output_mode IN ('normal', 'compressed'));
```

4. Inject prompt fragment in `buildCustomAgentSystemPrompt()` after `resolveCustomAgentPrompt()` output.

Reason: output style is behavioral, not factual task context. System prompt path already holds persona/procedure and is covered by prompt provenance.

5. Preserve escape hatch explicitly in prompt.

6. Add tests around prompt builder and repository serialization.

7. Add UI toggle only after backend exists:

- Agent editor: Output mode select (`Default`, `Normal`, `Compressed`).
- Task-run advanced option later.

## Measurement plan

### Metrics

Measure per task pair:

- Output tokens: from SDK result message `usage.output_tokens`.
- Input tokens: from SDK result message `usage.input_tokens` and context API usage where available.
- Wall time: session start/end timestamps if needed.
- Quality rubric score:
  - Task completed? yes/no
  - Correct files touched? yes/no
  - Tests/verification adequate? 0–2
  - Review findings actionable? 0–2
  - Safety/approval clarity preserved? yes/no
  - User-facing ambiguity introduced? yes/no

Primary target: >=50% median `output_tokens` reduction with no quality regression.

### Representative task set

Run identical tasks in `normal` and `compressed` modes:

1. Coder: small bug fix with unit test.
2. Coder: multi-file refactor with verification.
3. Reviewer: review PR diff and post verdict.
4. Research: investigate package/architecture and write doc.
5. QA: run failing test shard and report failure cause.
6. General: locate code path and summarize integration points.
7. Safety/approval case: destructive git/database operation requiring clear warning.

### Method

- Use same model/provider and fresh sessions.
- Disable unrelated prompt changes.
- Capture final SDK result messages and assistant text.
- Compare token counts and rubric scores.
- Record examples where compression harms clarity; refine escape hatch.

## Token-savings expectations

Caveman's upstream claims:

- Product description: ~75% output-token reduction.
- Benchmarks: average 65% output reduction across 10 prompts.
- Example table average: normal 1214 tokens vs Caveman 294 tokens.
- Memory compression: ~46% input-token reduction in examples.
- Subagent outputs: roughly 60% smaller by contract.

Existing NeoKai note (`05-caveman.md`) flags limitations:

- Reasoning/thinking tokens are untouched.
- Small replies can be offset by prompt overhead.
- Benchmarks do not prove correctness preservation.
- Savings depend on verbose output-heavy workflows.

NeoKai target should be more conservative: 50%+ output-token reduction in Space task outputs, quality-neutral.

## Licensing and maintenance

Caveman is MIT licensed (`package.json` and `LICENSE` show MIT, copyright Julius Brussee 2026). Reuse is legally feasible if copyright/license notice is preserved for copied substantial content.

Recommendation: avoid copying full Caveman text. Implement independent NeoKai wording inspired by evaluated behavior. This reduces attribution and drift burden and avoids product coupling to external branding.

If any Caveman prompt text, code, benchmarks, or command formats are copied substantially:

- Include MIT license notice in relevant third-party attribution.
- Track source commit/version.
- Add tests for any adapted behavior.

Maintenance risk of wholesale adoption is high because Caveman includes provider-specific installers, Claude Code hooks, MCP proxy behavior, slash commands, and statusline integration that NeoKai would need to keep compatible without direct runtime need.

## Decision

Adopt minimal native compressed output mode.

Do now:

- Prompt fragment only.
- Per-agent persistence first.
- Escape hatch required.
- Measurement harness/report before defaulting presets to compressed.

Defer:

- Caveman branding/persona.
- Intensity modes.
- Hooks/statusline/installer.
- Memory compressor.
- MCP shrink proxy.
- Default-on behavior.

## Acceptance criteria mapping

- Caveman reviewed: yes; prompt, hooks, stats, memory compression, MCP shrink, Cavecrew, licensing.
- Recommendation: prompt-only native compressed mode first; selected tool/skill ideas later.
- Minimal native behavior: recommended; no wholesale bundle.
- Escape hatch: required in prompt fragment and tests.
- Measurement: concrete paired-task plan targeting 50%+ output reduction without quality regression.

## Sources

- Caveman GitHub repository: <https://github.com/JuliusBrussee/caveman>
- Local Caveman skill prompt: `~/.claude/plugins/marketplaces/caveman/plugins/caveman/skills/caveman/SKILL.md`
- Local Caveman hooks: `~/.claude/plugins/marketplaces/caveman/src/hooks/`
- Local Caveman reviewer contract: `~/.claude/plugins/marketplaces/caveman/agents/cavecrew-reviewer.md`
- Caveman license: `~/.claude/plugins/marketplaces/caveman/LICENSE`
- NeoKai existing research note: `docs/research/token-efficiency/reports/05-caveman.md`
- NeoKai Space agent prompt builder: `packages/daemon/src/lib/space/agents/custom-agent.ts`
- NeoKai preset agents: `packages/daemon/src/lib/space/agents/seed-agents.ts`
- NeoKai Space agent types: `packages/shared/src/types/space.ts`
- NeoKai context usage extraction: `packages/daemon/src/lib/agent/context-fetcher.ts`
