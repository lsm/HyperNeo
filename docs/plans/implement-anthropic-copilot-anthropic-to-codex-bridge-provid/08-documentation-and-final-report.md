# Milestone 8: Documentation and Final Report

## Goal

Document the setup process for both providers, known limitations, and produce a final parity report summarizing completed closures and remaining gaps.

## Scope

- `docs/` -- Setup documentation, known limitations, final parity report

---

### Task 8.1: Provider Setup Documentation

**Description:** Create or update documentation for setting up both the `anthropic-copilot` and `anthropic-codex` providers, including authentication methods, environment variables, and troubleshooting.

**Agent type:** general

**Subtasks:**
1. Review existing documentation files under `docs/` for any provider setup information.
2. Create `docs/providers/anthropic-copilot-setup.md` with:
   - Overview of the provider and what it does.
   - Authentication methods: HyperNeo OAuth, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `gh auth login`, `~/.config/gh/hosts.yml`.
   - Step-by-step setup for each method.
   - Troubleshooting: classic PAT rejection, token validation failures, enterprise GitHub.
   - Known limitations: no vision, no extended thinking, heuristic token counting, `tool_choice` limitations.
3. Create `docs/providers/anthropic-codex-setup.md` with:
   - Overview of the provider and what it does.
   - Authentication methods: `OPENAI_API_KEY`, `CODEX_API_KEY`, HyperNeo OAuth (ChatGPT Plus/Pro), `codex login` migration.
   - Step-by-step setup for each method.
   - Requirement: `codex` CLI must be on PATH.
   - Troubleshooting: codex binary not found, OAuth token refresh, workspace isolation.
   - Known limitations: no vision, no extended thinking, heuristic token counting (unless real usage wired), text-flattened conversation semantics, single-tool-result limitation.
4. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Setup docs exist for both providers.
- Each doc covers authentication, setup steps, and troubleshooting.
- Known limitations are clearly documented.

**Dependencies:** All Milestones 1-7

---

### Task 8.2: Final Parity Report

**Description:** Produce a final parity report summarizing what was achieved, what parity gaps remain, and test evidence for each closure.

**Agent type:** general

**Subtasks:**
1. Review the original parity reports:
   - `docs/reports/anthropic-copilot-parity-report.md`
   - `docs/codex-anthropic-api-parity-review.md`
   - `docs/reports/codex-anthropic-parity-report.md`
2. Create `docs/reports/provider-parity-final-report.md` with sections:
   - **Executive Summary**: What was achieved and overall parity status.
   - **anthropic-copilot Provider**:
     - Closures: error mapping, token usage, type safety, UI integration, routing.
     - Remaining gaps: vision, extended thinking, `tool_choice` (if not supported by SDK).
     - Test evidence: list of tests and their results.
   - **anthropic-codex Provider**:
     - Closures: multiple tool results, error envelopes, token usage, type safety, UI integration, routing.
     - Remaining gaps: `stream: false`, vision, extended thinking, `tool_choice`, full conversation semantics, `stop_sequences`.
     - Test evidence: list of tests and their results.
   - **Shared Improvements**:
     - Type system widening.
     - Collision-safe routing.
     - Provider-grouped model picker.
     - Auth UX indicators.
   - **Remaining Work**: Prioritized list of gaps not addressed in this plan.
3. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Final report covers both providers with per-gap closure status.
- Test evidence is cited for each closure.
- Remaining gaps are clearly listed with priority.
- The report supersedes the three original parity reports.

**Dependencies:** All Milestones 1-7
