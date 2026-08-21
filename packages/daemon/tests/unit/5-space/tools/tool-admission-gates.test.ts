import { describe, expect, test } from 'bun:test';
import {
  decideAutonomyAdmission,
  getToolAutonomyRequirement,
  resolveEffectiveAutonomyLevel,
  SESSION_WRITE_AUTONOMY_LEVEL,
  TOOL_AUTONOMY_REQUIREMENTS,
} from '../../../../src/lib/space/tools/tool-admission-gates.ts';

describe('resolveEffectiveAutonomyLevel', () => {
  test('null agentLevel falls back to the space level for every space level', () => {
    for (const spaceLevel of [1, 2, 3, 4, 5]) {
      expect(resolveEffectiveAutonomyLevel({ spaceLevel, agentLevel: null })).toEqual({
        level: spaceLevel,
        agentCeilingBinding: false,
      });
    }
  });

  test('non-null agentLevel resolves to the min of space and agent levels', () => {
    expect(resolveEffectiveAutonomyLevel({ spaceLevel: 5, agentLevel: 3 })).toEqual({
      level: 3,
      agentCeilingBinding: true,
    });
    expect(resolveEffectiveAutonomyLevel({ spaceLevel: 3, agentLevel: 5 })).toEqual({
      level: 3,
      agentCeilingBinding: false,
    });
    expect(resolveEffectiveAutonomyLevel({ spaceLevel: 4, agentLevel: 4 })).toEqual({
      level: 4,
      agentCeilingBinding: false,
    });
    expect(resolveEffectiveAutonomyLevel({ spaceLevel: 1, agentLevel: 1 })).toEqual({
      level: 1,
      agentCeilingBinding: false,
    });
  });

  test('agentCeilingBinding is true only when the agent level is strictly below the space level', () => {
    const bindingCases = [
      [5, 1],
      [5, 4],
      [4, 3],
      [3, 1],
    ] as const;
    for (const [spaceLevel, agentLevel] of bindingCases) {
      expect(resolveEffectiveAutonomyLevel({ spaceLevel, agentLevel })).toEqual({
        level: agentLevel,
        agentCeilingBinding: true,
      });
    }
    const nonBindingCases = [
      [5, 5],
      [3, 4],
      [3, 5],
      [1, 1],
    ] as const;
    for (const [spaceLevel, agentLevel] of nonBindingCases) {
      expect(resolveEffectiveAutonomyLevel({ spaceLevel, agentLevel })).toEqual({
        level: spaceLevel,
        agentCeilingBinding: false,
      });
    }
  });
});

describe('decideAutonomyAdmission', () => {
  test('allows when the effective level meets or exceeds the required level', () => {
    expect(
      decideAutonomyAdmission({
        toolName: 'update_session_state',
        level: 4,
        required: 4,
        agentLevel: 4,
        spaceLevel: 5,
      })
    ).toEqual({ action: 'allow' });
    expect(
      decideAutonomyAdmission({
        toolName: 'interrupt_session',
        level: 5,
        required: 4,
        agentLevel: null,
        spaceLevel: 5,
      })
    ).toEqual({ action: 'allow' });
    expect(
      decideAutonomyAdmission({
        toolName: 'send_session_message',
        level: 4,
        required: 4,
        agentLevel: null,
        spaceLevel: 4,
      })
    ).toEqual({ action: 'allow' });
  });

  test('denies below the required level with the space reason when no agent ceiling binds', () => {
    const decision = decideAutonomyAdmission({
      toolName: 'update_session_state',
      level: 3,
      required: 4,
      agentLevel: null,
      spaceLevel: 3,
    });
    expect(decision).toEqual({
      action: 'deny',
      reason: 'space_autonomy_level',
      spaceLevel: 3,
      required: 4,
      message:
        'update_session_state not permitted: space autonomy level 3 < required level 4. Request human approval.',
    });
  });

  test('denies below the required level with the space reason when the agent level is at or above the space level', () => {
    const agentAtSpace = decideAutonomyAdmission({
      toolName: 'interrupt_session',
      level: 3,
      required: 4,
      agentLevel: 3,
      spaceLevel: 3,
    });
    expect(agentAtSpace.action).toBe('deny');
    if (agentAtSpace.action === 'deny') {
      expect(agentAtSpace.reason).toBe('space_autonomy_level');
      expect(agentAtSpace.agentLevel).toBeUndefined();
      expect(agentAtSpace.message).toBe(
        'interrupt_session not permitted: space autonomy level 3 < required level 4. Request human approval.'
      );
    }
    const agentAboveSpace = decideAutonomyAdmission({
      toolName: 'interrupt_session',
      level: 3,
      required: 4,
      agentLevel: 5,
      spaceLevel: 3,
    });
    expect(agentAboveSpace.action).toBe('deny');
    if (agentAboveSpace.action === 'deny') {
      expect(agentAboveSpace.reason).toBe('space_autonomy_level');
      expect(agentAboveSpace.agentLevel).toBeUndefined();
    }
  });

  test('denies below the required level with the agent ceiling reason when the agent level binds', () => {
    const decision = decideAutonomyAdmission({
      toolName: 'send_session_message',
      level: 1,
      required: 4,
      agentLevel: 1,
      spaceLevel: 5,
    });
    expect(decision).toEqual({
      action: 'deny',
      reason: 'agent_autonomy_ceiling',
      agentLevel: 1,
      spaceLevel: 5,
      required: 4,
      message:
        'send_session_message not permitted: agent autonomy ceiling 1 (space 5) < required level 4. Request human approval.',
    });
  });

  test('selects the ceiling reason only when the agent level both binds and the effective level is below the requirement', () => {
    expect(
      decideAutonomyAdmission({
        toolName: 'update_session_state',
        level: 4,
        required: 4,
        agentLevel: 4,
        spaceLevel: 5,
      })
    ).toEqual({ action: 'allow' });
    const binding = decideAutonomyAdmission({
      toolName: 'update_session_state',
      level: 3,
      required: 4,
      agentLevel: 3,
      spaceLevel: 5,
    });
    if (binding.action === 'deny') {
      expect(binding.reason).toBe('agent_autonomy_ceiling');
      expect(binding.agentLevel).toBe(3);
      expect(binding.spaceLevel).toBe(5);
      expect(binding.required).toBe(4);
      expect(binding.message).toBe(
        'update_session_state not permitted: agent autonomy ceiling 3 (space 5) < required level 4. Request human approval.'
      );
    } else {
      throw new Error('expected deny');
    }
  });

  test('deny messages embed the calling tool name and levels word-for-word', () => {
    const ceiling = decideAutonomyAdmission({
      toolName: 'interrupt_session',
      level: 2,
      required: 4,
      agentLevel: 2,
      spaceLevel: 5,
    });
    if (ceiling.action === 'deny') {
      expect(ceiling.message).toBe(
        'interrupt_session not permitted: agent autonomy ceiling 2 (space 5) < required level 4. Request human approval.'
      );
      expect(ceiling.message).toContain('interrupt_session not permitted');
      expect(ceiling.message).toContain('(space 5)');
    } else {
      throw new Error('expected deny');
    }
    const space = decideAutonomyAdmission({
      toolName: 'interrupt_session',
      level: 2,
      required: 4,
      agentLevel: null,
      spaceLevel: 2,
    });
    if (space.action === 'deny') {
      expect(space.message).toBe(
        'interrupt_session not permitted: space autonomy level 2 < required level 4. Request human approval.'
      );
      expect(space.message).not.toContain('agent autonomy ceiling');
    } else {
      throw new Error('expected deny');
    }
  });
});

describe('TOOL_AUTONOMY_REQUIREMENTS', () => {
  test('seeds every session-write tool at SESSION_WRITE_AUTONOMY_LEVEL', () => {
    expect(Object.keys(TOOL_AUTONOMY_REQUIREMENTS).sort()).toEqual([
      'interrupt_session',
      'send_session_message',
      'update_session_state',
    ]);
    for (const required of Object.values(TOOL_AUTONOMY_REQUIREMENTS)) {
      expect(required).toBe(SESSION_WRITE_AUTONOMY_LEVEL);
    }
    expect(SESSION_WRITE_AUTONOMY_LEVEL).toBe(4);
  });

  test('direct lookup of an unlisted tool yields undefined (ungated)', () => {
    expect(TOOL_AUTONOMY_REQUIREMENTS.list_space_sessions).toBeUndefined();
    expect(TOOL_AUTONOMY_REQUIREMENTS.approve_task).toBeUndefined();
    expect(TOOL_AUTONOMY_REQUIREMENTS['Bash(gh pr view:*)']).toBeUndefined();
  });
});

describe('getToolAutonomyRequirement', () => {
  test('returns the required level for gated session-write tools', () => {
    expect(getToolAutonomyRequirement('send_session_message')).toBe(4);
    expect(getToolAutonomyRequirement('update_session_state')).toBe(4);
    expect(getToolAutonomyRequirement('interrupt_session')).toBe(4);
  });

  test('returns undefined for unlisted tools, encoding the ungated default', () => {
    expect(getToolAutonomyRequirement('list_space_sessions')).toBeUndefined();
    expect(getToolAutonomyRequirement('approve_task')).toBeUndefined();
    expect(getToolAutonomyRequirement('unknown_tool')).toBeUndefined();
  });

  test('returns undefined for Object.prototype-inherited keys instead of inherited values', () => {
    for (const inheritedKey of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(getToolAutonomyRequirement(inheritedKey)).toBeUndefined();
    }
  });
});
