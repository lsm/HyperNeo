/**
 * Unit tests for buildPostApprovalInit — the pure helper that strips
 * worker-derived tool restrictions and appends the Reviewer read-only-rule
 * override for post-approval merge sessions.
 *
 * Covers the r2 strip + r4 prompt-override append behaviour that the
 * spawnPostApprovalSubSession integration tests stub out.
 */

import { describe, expect, it } from 'bun:test';
import {
  buildPostApprovalInit,
  POST_APPROVAL_PROMPT_OVERRIDE,
} from '../../../../src/lib/space/runtime/post-approval-init';
import type { AgentSessionInit } from '../../../../src/lib/agent/agent-session';

function makeInit(overrides: Partial<AgentSessionInit> = {}): AgentSessionInit {
  return {
    sessionId: 'session-1',
    title: 'Post-Approval Merge',
    model: 'claude-sonnet',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    mcpServers: {},
    ...overrides,
  } as AgentSessionInit;
}

describe('buildPostApprovalInit', () => {
  it('clears session-level disallowedTools when present', () => {
    const init = makeInit({ disallowedTools: ['Bash', 'Write'] });
    const result = buildPostApprovalInit(init);

    expect(result.disallowedTools).toBeUndefined();
  });

  it('leaves session-level disallowedTools unset when already absent', () => {
    const init = makeInit({ disallowedTools: undefined });
    const result = buildPostApprovalInit(init);

    expect(result.disallowedTools).toBeUndefined();
    // No agents key touched — init returned essentially unchanged.
    expect(result.agent).toBeUndefined();
    expect(result.agents).toBeUndefined();
  });

  it('clears session-level toolGuards when present', () => {
    // Post-approval merge sessions must be able to run `gh pr merge`. A
    // pre-existing guard like CODER_NO_MERGE_GUARD on the routed slot would
    // deny that exact command while the prompt override tells the session
    // to run it, so toolGuards must be stripped alongside disallowedTools.
    const init = makeInit({
      toolGuards: [
        {
          type: 'tool',
          tool: 'Bash',
          denyPatterns: ['gh pr merge*'],
          message: 'do not merge',
        },
      ] as unknown as AgentSessionInit['toolGuards'],
    });
    const result = buildPostApprovalInit(init);

    expect(result.toolGuards).toBeUndefined();
  });

  it('leaves session-level toolGuards unset when already absent', () => {
    const init = makeInit({ toolGuards: undefined });
    const result = buildPostApprovalInit(init);

    expect(result.toolGuards).toBeUndefined();
  });

  it('clears disallowedTools only on the active agent and appends the override', () => {
    const init = makeInit({
      agent: 'reviewer',
      disallowedTools: ['Bash', 'REPL', 'Workflow'],
      agents: {
        reviewer: {
          description: 'Reviewer',
          prompt: 'Reviewer system contract goes here.',
          disallowedTools: ['Bash', 'REPL', 'Workflow'],
          model: 'inherit',
        },
      },
    });

    const result = buildPostApprovalInit(init);

    expect(result.disallowedTools).toBeUndefined();
    const active = (
      result.agents as Record<string, { disallowedTools?: string[]; prompt?: string }>
    )['reviewer'];
    expect(active.disallowedTools).toBeUndefined();
    expect(active.prompt).toContain('Reviewer system contract goes here.');
    expect(active.prompt).toContain('Post-Approval Override');
    expect(active.prompt).toContain('`gh pr merge`');
  });

  it('exposes the exact override text via POST_APPROVAL_PROMPT_OVERRIDE', () => {
    // Tests rely on this constant so future prose changes are intentional.
    expect(POST_APPROVAL_PROMPT_OVERRIDE).toContain('Post-Approval Override');
    expect(POST_APPROVAL_PROMPT_OVERRIDE).toContain('gh pr merge');
    expect(POST_APPROVAL_PROMPT_OVERRIDE).toContain('gh pr view');
    expect(POST_APPROVAL_PROMPT_OVERRIDE).toContain('gh pr checks');
    expect(POST_APPROVAL_PROMPT_OVERRIDE).toContain('git fetch');
    expect(POST_APPROVAL_PROMPT_OVERRIDE).toContain('git checkout');
    expect(POST_APPROVAL_PROMPT_OVERRIDE).toContain('does NOT apply to this session');
  });

  it('leaves other agent definitions in init.agents untouched', () => {
    const init = makeInit({
      agent: 'reviewer',
      disallowedTools: ['Bash'],
      agents: {
        reviewer: {
          description: 'Reviewer',
          prompt: 'Reviewer contract.',
          disallowedTools: ['Bash'],
          model: 'inherit',
        },
        other: {
          description: 'Other agent',
          prompt: 'Other contract.',
          disallowedTools: ['Write'],
          model: 'inherit',
        },
      },
    });

    const result = buildPostApprovalInit(init);
    const agents = result.agents as Record<
      string,
      { disallowedTools?: string[]; prompt?: string; description: string }
    >;

    expect(agents.reviewer?.disallowedTools).toBeUndefined();
    expect(agents.reviewer?.prompt).toContain('Post-Approval Override');
    // The other entry is unchanged.
    expect(agents.other?.disallowedTools).toEqual(['Write']);
    expect(agents.other?.prompt).toBe('Other contract.');
  });

  it('is a no-op when init.agent is set but init.agents lacks that key', () => {
    const init = makeInit({
      agent: 'reviewer',
      disallowedTools: ['Bash'],
      agents: {
        other: { description: 'x', prompt: 'y', model: 'inherit' },
      } as AgentSessionInit['agents'],
    });

    const result = buildPostApprovalInit(init);

    // Session-level strip still applies.
    expect(result.disallowedTools).toBeUndefined();
    // agents map is unchanged (no override appended to a missing active def).
    expect(result.agents).toEqual(init.agents);
  });

  it('appends the override even when the active agent has no existing prompt', () => {
    const init = makeInit({
      agent: 'reviewer',
      disallowedTools: ['Bash'],
      agents: {
        reviewer: {
          description: 'Reviewer',
          model: 'inherit',
        },
      } as AgentSessionInit['agents'],
    });

    const result = buildPostApprovalInit(init);
    const active = (result.agents as Record<string, { prompt?: string }>)['reviewer'];

    expect(active.prompt).toBe(POST_APPROVAL_PROMPT_OVERRIDE);
  });
});
