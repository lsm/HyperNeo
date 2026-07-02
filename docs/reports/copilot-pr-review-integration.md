# GitHub Copilot CLI PR Review Workflow Integration

**Date:** 2026-03-14

---

## Overview

This document describes how to integrate the GitHub Copilot CLI into HyperNeo's
PR review workflow (as designed in `docs/design/pr-review-workflow.md`).

---

## Current Reviewer Agent Architecture

From `pr-review-workflow.md`, reviewers are spawned as sub-agents:
```json
{
  "reviewers": [
    { "model": "claude-opus-4-6", "provider": "anthropic" },
    { "model": "glm-5", "provider": "glm" },
    { "model": "codex", "type": "cli" }
  ],
  "maxReviewRounds": 5
}
```

The "cli" type reviewer is the key integration point for the Copilot CLI.

---

## Copilot CLI PR Review Commands

### Basic PR Review

```bash
# Review a PR by URL
copilot -p "review this PR: https://github.com/owner/repo/pull/42" \
  --allow-all \
  --output-format json \
  --silent \
  --model claude-opus-4.6

# Review with diff context
copilot -p "Review these changes and identify security issues:\n$(gh pr diff 42)" \
  --allow-all \
  --output-format json \
  --silent \
  --model gpt-5.3-codex
```

### PR Comment Posting

The CLI can post PR comments autonomously:
```bash
copilot -p "Review PR #42, post specific inline comments for each issue found,
           and post a summary review comment" \
  --allow-all \
  --output-format json \
  --silent
```

### Multi-Round Review

For follow-up review rounds, use `--resume <sessionId>`:
```bash
# Round 1
copilot -p "Review PR #42" --output-format json --silent --allow-all
# → sessionId: "s_abc123"

# Round 2 (after developer addresses feedback)
copilot -p "The developer addressed your concerns. Re-review PR #42 for remaining issues." \
  --output-format json --silent --allow-all \
  --resume s_abc123
```

---

## Integration Design with Leader Agent Workflow

### Design: Copilot CLI as Reviewer Sub-Agent

In the current design, the leader spawns reviewer sub-agents via the `Task` tool.
A "Copilot CLI reviewer" would be:

```typescript
// In buildReviewerAgents()
if (reviewer.type === 'cli' && reviewer.model?.includes('copilot')) {
  // Use CopilotCliProvider instead of standard SDK session
  return buildCopilotCliReviewerAgent(reviewer, prUrl, taskContext);
}
```

### Reviewer Sub-Agent Flow

```
Leader Agent
  │──spawn reviewer──→ CopilotCliProvider.createQuery()
  │                          │──copilot process──→ Reviews PR via GitHub API
  │                          │←─NDJSON stream────────────────────────
  │←─SDKMessages(stream)──── │
  │                          │
  │  (reads review feedback from stream)
  │──post summary──────────→ (via copilot's built-in gh tool)
```

### Session Resume for Multi-Round Reviews

The PR review workflow has multiple rounds. Using `--resume`:

```typescript
class CopilotCliReviewSession {
  private sessionId: string | null = null;

  async reviewRound(prNumber: number, round: number): AsyncGenerator<SDKMessage> {
    const prompt = round === 1
      ? `Review PR #${prNumber}. Post specific inline comments for each issue.
         Categorize as P0 (blocking), P1 (important), P2 (nice to have).`
      : `Round ${round} review of PR #${prNumber}. The developer has addressed previous feedback.
         Focus on whether P0 and P1 issues from round ${round - 1} are fully resolved.`;

    return copilotCliQueryGenerator(prompt, {
      resumeSessionId: this.sessionId ?? undefined,
      onSessionId: (id) => { this.sessionId = id; }
    });
  }
}
```

---

## Example: Full PR Review Prompts

### Initial Review Prompt
```
Review the changes in PR #42 (https://github.com/lsm/neokai/pull/42).

Focus on:
1. Security vulnerabilities (P0 - blocking)
2. Correctness bugs (P1 - important)
3. Performance issues (P1 - important)
4. Code style and maintainability (P2 - nice to have)

For each finding:
- Post an inline comment on the specific line using `gh pr comment`
- Include the severity level (P0/P1/P2)
- Suggest a fix

After reviewing all files, post a summary review comment with:
- Overall assessment (APPROVE/REQUEST_CHANGES/COMMENT)
- List of all P0 and P1 findings
- Whether it's safe to merge
```

### Follow-Up Review Prompt (Round 2+)
```
This is review round 2 for PR #42.

Previous feedback has been addressed by the developer. Please:
1. Check if all P0 and P1 issues from round 1 are resolved
2. Review the new commits added since round 1
3. Post comments only for new issues or unresolved previous issues
4. Post a final summary indicating if P0/P1 issues are resolved

Use `gh pr view 42 --comments` to see previous review comments.
Use `gh pr diff 42` to see latest changes.
```

---

## Comparison: Copilot CLI Reviewer vs. Current Approach

### Current Approach (SDK-based reviewer)
```
Leader
  │──Task tool──→ Reviewer Agent (SDK session)
  │                  │──reads PR via gh API──→ GitHub
  │                  │──analyzes code──────→ LLM API
  │                  │──posts comments────→ GitHub API
  │←─task result────│
```

### Copilot CLI Approach
```
Leader
  │──Task tool──→ Reviewer Agent (CopilotCliProvider)
  │                  │──spawn copilot─────→ CLI subprocess
  │                  │                        │──reads PR──→ GitHub
  │                  │                        │──analyzes──→ LLM API (via Copilot)
  │                  │                        │──posts comments──→ GitHub API
  │                  │←─NDJSON stream─────── │
  │←─SDKMessages────│
```

### Advantages of Copilot CLI Reviewer
1. **Native GitHub integration** — CLI has optimized GitHub API access, understands PR structure
2. **Built-in context retrieval** — Automatically fetches PR diff, comments, code context
3. **Model flexibility** — Can use gpt-5.3-codex which may be better for code review
4. **Reduced HyperNeo code** — No need to manage gh API calls, PR comment posting
5. **Consistent behavior** — CLI uses tested review patterns from GitHub's AI team

### Disadvantages of Copilot CLI Reviewer
1. **No tool interception** — Cannot inspect or modify what the CLI does
2. **Black box** — Less observability into the review process
3. **Binary dependency** — Requires copilot CLI installed on the system
4. **Session opacity** — Cannot inspect conversation history for debugging
5. **Rate limits** — Copilot API rate limits apply, may conflict with other usage

---

## Configuration Design

### Room Config for Copilot CLI Reviewer

```typescript
interface ReviewerConfig {
  model: string;
  provider?: string;
  type?: 'cli';
  cliPath?: string;       // Path to copilot binary (default: 'copilot')
  githubToken?: string;   // Override token (default: from environment)
}

// Example room config:
{
  "reviewers": [
    { "model": "claude-opus-4-6", "provider": "anthropic" },
    {
      "model": "gpt-5.3-codex",
      "type": "cli",
      "cliPath": "/usr/local/bin/copilot"
    }
  ],
  "maxReviewRounds": 3
}
```

---

## Recommendation for PR Review Integration

**For HyperNeo's PR review workflow, the Copilot CLI is best used as a "secondary" reviewer**
alongside the existing SDK-based reviewers:

1. **Primary reviewer:** Anthropic Claude via SDK (existing approach) — full observability
2. **Secondary reviewer:** Copilot CLI with gpt-5.3-codex — for OpenAI model perspective
3. **Native GitHub reviewer:** Copilot CLI — for GitHub-specific context (issues, PR history)

The CLI's native GitHub integration makes it particularly valuable for reviews that
require deep GitHub context (PR history, related issues, codebase ownership patterns).

**Not recommended as sole reviewer** due to reduced observability and black-box behavior.
