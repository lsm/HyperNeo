/**
 * Unit tests for the long-term-agent config-refresh helpers.
 *
 * Covers detection + desired-config derivation for the ensureLongTermAgentSession
 * refresh path, mirroring the post-approval-init helper test pattern. Ensures
 * upgraded Spaces with stale sdkToolsPreset / exhaustive disallowedTools
 * configurations are detected and refreshed to the current permissive policy.
 */

import { describe, expect, it } from 'bun:test';
import {
  buildLongTermAgentDesiredConfig,
  longTermAgentSessionNeedsRefresh,
} from '../../../../src/lib/space/runtime/long-term-agent-config-refresh';
import type { SpaceAgent, Session } from '@neokai/shared';

function makeAgent(overrides: Partial<SpaceAgent> = {}): SpaceAgent {
  return {
    id: 'agent-1',
    spaceId: 'space-1',
    name: 'Test Agent',
    customPrompt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeConfigSlice(
  overrides: Partial<Session['config']> = {}
): Pick<
  Session['config'],
  'sdkToolsPreset' | 'allowedTools' | 'disallowedTools' | 'agent' | 'agents'
> {
  return {
    sdkToolsPreset: undefined,
    allowedTools: undefined,
    disallowedTools: undefined,
    agent: undefined,
    agents: undefined,
    ...overrides,
  } as Pick<
    Session['config'],
    'sdkToolsPreset' | 'allowedTools' | 'disallowedTools' | 'agent' | 'agents'
  >;
}

describe('buildLongTermAgentDesiredConfig', () => {
  it('returns all-undefined for a permissive agent (no denies)', () => {
    const desired = buildLongTermAgentDesiredConfig(
      makeAgent({ tools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'NotebookEdit'] })
    );

    expect(desired.sdkToolsPreset).toBeUndefined();
    expect(desired.allowedTools).toBeUndefined();
    expect(desired.disallowedTools).toBeUndefined();
    expect(desired.agent).toBeUndefined();
    expect(desired.agents).toBeUndefined();
  });

  it('derives a deny list and agent entry for a restricted agent', () => {
    const desired = buildLongTermAgentDesiredConfig(
      makeAgent({
        name: 'Reviewer',
        templateName: 'Reviewer',
        description: 'Read-only reviewer',
        tools: ['Read', 'Bash', 'Grep'],
      })
    );

    // Reviewer denies mutation + aux but keeps Bash for read shell.
    expect(desired.disallowedTools).not.toContain('Bash');
    expect(desired.disallowedTools).toContain('Write');
    expect(desired.disallowedTools).toContain('MultiEdit');
    expect(desired.agent).toBe('reviewer');
    expect(desired.agents?.['reviewer']?.disallowedTools).toBe(desired.disallowedTools);
    expect(desired.agents?.['reviewer']?.description).toBe('Read-only reviewer');
    expect(typeof desired.agents?.['reviewer']?.prompt).toBe('string');
  });

  it('forces the mutation deny list for preset Reviewer even when stored profile has Bash', () => {
    const desired = buildLongTermAgentDesiredConfig(
      makeAgent({
        name: 'Reviewer',
        templateName: 'Reviewer',
        // Stale pre-migration profile.
        tools: ['Read', 'Bash', 'Write', 'Edit'],
      })
    );

    // Reviewer keeps Bash; denies mutation + aux.
    expect(desired.disallowedTools).not.toContain('Bash');
    expect(desired.disallowedTools).toEqual(
      expect.arrayContaining(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
    );
    expect(desired.disallowedTools).toContain('Projects');
    expect(desired.disallowedTools).toContain('TodoWrite');
    expect(desired.agent).toBe('reviewer');
  });

  it('appends the Reviewer contract migration override to the long-term agent prompt', () => {
    // Stale preset Reviewer: stored customPrompt still carries the old
    // shell-based review procedure. The long-term refresh path must append
    // the current REVIEWER_SYSTEM_CONTRACT under a migration-override header
    // so the model does not keep calling `gh pr review` / `gh pr diff` once
    // Bash is denied.
    const desired = buildLongTermAgentDesiredConfig(
      makeAgent({
        name: 'Reviewer',
        templateName: 'Reviewer',
        customPrompt: 'Old shell-based reviewer procedure: run `gh pr diff` etc.',
        tools: ['Read', 'Bash'],
      })
    );

    expect(desired.agents?.['reviewer']?.prompt).toContain(
      '## Updated Reviewer Contract (migration override; supersedes any conflicting shell-based review procedure above)'
    );
    expect(desired.agents?.['reviewer']?.prompt).toContain('Reviewer System Contract');
    expect(desired.agents?.['reviewer']?.prompt).toContain('Old shell-based reviewer procedure');
  });

  it('does not append the migration override for non-Reviewer presets', () => {
    const desired = buildLongTermAgentDesiredConfig(
      makeAgent({
        name: 'Custom Agent',
        templateName: null,
        tools: ['Read'],
      })
    );

    if (desired.agents?.['custom-agent']?.prompt) {
      expect(desired.agents['custom-agent'].prompt).not.toContain(
        'Updated Reviewer Contract (migration override'
      );
    }
  });
});

describe('longTermAgentSessionNeedsRefresh', () => {
  it('returns true when current config has a stale sdkToolsPreset', () => {
    const current = makeConfigSlice({ sdkToolsPreset: 'claude_code' as never });
    const desired = buildLongTermAgentDesiredConfig(makeAgent({ tools: ['Read'] }));

    expect(longTermAgentSessionNeedsRefresh(current, desired)).toBe(true);
  });

  it('returns true when current config has stale allowedTools', () => {
    const current = makeConfigSlice({
      allowedTools: ['Read', 'Write'] as never,
    });
    const desired = buildLongTermAgentDesiredConfig(makeAgent({ tools: ['Read'] }));

    expect(longTermAgentSessionNeedsRefresh(current, desired)).toBe(true);
  });

  it('returns true when disallowedTools differ from the desired deny list', () => {
    const current = makeConfigSlice({
      disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit'],
    });
    const desired = buildLongTermAgentDesiredConfig(
      makeAgent({ name: 'Reviewer', templateName: 'Reviewer', tools: ['Read'] })
    );

    expect(longTermAgentSessionNeedsRefresh(current, desired)).toBe(true);
  });

  it('returns true when agent key differs', () => {
    const desired = buildLongTermAgentDesiredConfig(
      makeAgent({ name: 'Reviewer', templateName: 'Reviewer', tools: ['Read'] })
    );
    const current = makeConfigSlice({
      disallowedTools: desired.disallowedTools,
      agent: 'stale-agent-key',
      agents: desired.agents,
    });

    expect(longTermAgentSessionNeedsRefresh(current, desired)).toBe(true);
  });

  it('returns true when agents map differs', () => {
    const desired = buildLongTermAgentDesiredConfig(
      makeAgent({ name: 'Reviewer', templateName: 'Reviewer', tools: ['Read'] })
    );
    const current = makeConfigSlice({
      disallowedTools: desired.disallowedTools,
      agent: desired.agent,
      agents: { reviewer: { description: 'stale', prompt: 'stale', model: 'inherit' } as never },
    });

    expect(longTermAgentSessionNeedsRefresh(current, desired)).toBe(true);
  });

  it('returns false when current config matches the desired permissive policy', () => {
    const desired = buildLongTermAgentDesiredConfig(
      makeAgent({ tools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'NotebookEdit'] })
    );
    const current = makeConfigSlice({
      sdkToolsPreset: undefined,
      allowedTools: undefined,
      disallowedTools: undefined,
      agent: undefined,
      agents: undefined,
    });

    expect(longTermAgentSessionNeedsRefresh(current, desired)).toBe(false);
  });

  it('returns false when current config matches the desired deny policy', () => {
    const desired = buildLongTermAgentDesiredConfig(
      makeAgent({ name: 'Reviewer', templateName: 'Reviewer', tools: ['Read'] })
    );
    const current = makeConfigSlice({
      sdkToolsPreset: undefined,
      allowedTools: undefined,
      disallowedTools: desired.disallowedTools,
      agent: desired.agent,
      agents: desired.agents,
    });

    expect(longTermAgentSessionNeedsRefresh(current, desired)).toBe(false);
  });
});
