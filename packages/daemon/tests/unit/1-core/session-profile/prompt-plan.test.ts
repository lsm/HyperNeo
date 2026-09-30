import { describe, expect, test } from 'bun:test';
import {
  classifySession,
  type DeclaredCapability,
  type SessionFacts,
} from '../../../../src/lib/session-profile/classify.ts';
import { resolvePromptPlan } from '../../../../src/lib/session-profile/prompt-plan.ts';

function agentProfile(declared: readonly DeclaredCapability[] = []) {
  return classifySession({
    sessionId: 'space:agent:space-1:agent-1',
    sessionType: 'long_horizon_agent',
    spaceId: 'space-1',
    agentId: 'agent-1',
    isCanonicalAgentSession: true,
    declaredCapabilities: declared,
  } satisfies SessionFacts);
}

const input = {
  instructions: 'Own the release.',
  ownerReviewContract: 'OWNER CONTRACT',
  schedulingGuardrail: 'SCHEDULING GUARDRAIL',
};

describe('resolvePromptPlan', () => {
  test('renders only the agent instructions for an agent that holds nothing', () => {
    const plan = resolvePromptPlan({ profile: agentProfile(), ...input });

    expect(plan.entries.map((entry) => entry.unit)).toEqual(['space.agent.instructions']);
    expect(plan.text).toBe('Own the release.');
  });

  test('adds the owner contract only when the agent holds goals', () => {
    const plan = resolvePromptPlan({ profile: agentProfile(['holds.goals']), ...input });

    expect(plan.entries.map((entry) => entry.unit)).toEqual([
      'space.agent.instructions',
      'space.agent.goalOwner',
    ]);
    expect(plan.text).toContain('OWNER CONTRACT');
    expect(plan.text).not.toContain('SCHEDULING GUARDRAIL');
  });

  test('adds the scheduling guardrail only when the agent holds schedules', () => {
    const plan = resolvePromptPlan({ profile: agentProfile(['holds.schedules']), ...input });

    expect(plan.entries.map((entry) => entry.unit)).toEqual([
      'space.agent.instructions',
      'space.agent.scheduling',
    ]);
    expect(plan.text).toContain('SCHEDULING GUARDRAIL');
    expect(plan.text).not.toContain('OWNER CONTRACT');
  });

  test('composes every held unit in registry order', () => {
    const plan = resolvePromptPlan({
      profile: agentProfile(['holds.schedules', 'holds.goals']),
      ...input,
    });

    expect(plan.entries.map((entry) => entry.unit)).toEqual([
      'space.agent.instructions',
      'space.agent.goalOwner',
      'space.agent.scheduling',
    ]);
    expect(plan.text).toBe('Own the release.\n\nOWNER CONTRACT\n\nSCHEDULING GUARDRAIL');
  });

  test('renders the escalation target for a holder', () => {
    const plan = resolvePromptPlan({
      profile: agentProfile(['responsibilities.escalation']),
      escalationTarget: 'space-manager',
      escalationHumanFallback: 'no holder',
    });

    expect(plan.text).toContain('@space-manager');
  });

  test('falls back to the human line when no agent holds escalation', () => {
    const plan = resolvePromptPlan({
      profile: agentProfile(['responsibilities.escalation']),
      escalationTarget: null,
      escalationHumanFallback: 'No agent holds escalation; surface it to the human operator.',
    });

    expect(plan.text).toContain('surface it to the human operator');
  });

  test('reports held units that produced no text as unresolved', () => {
    const plan = resolvePromptPlan({ profile: agentProfile(['holds.goals']) });

    expect(plan.entries).toEqual([]);
    expect(plan.unresolved).toContain('space.agent.goalOwner');
    expect(plan.text).toBeUndefined();
  });
});
