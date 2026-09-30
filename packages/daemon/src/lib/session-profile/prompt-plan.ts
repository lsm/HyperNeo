import type { SessionCapability, SessionProfile } from './classify.ts';

export type PromptUnitId =
  | 'space.agent.instructions'
  | 'space.agent.goalOwner'
  | 'space.agent.scheduling'
  | 'space.agent.escalation';

export interface PromptPlanInput {
  readonly profile: SessionProfile;
  readonly instructions?: string;
  readonly ownerReviewContract?: string;
  readonly schedulingGuardrail?: string;
  readonly escalationTarget?: string | null;
  readonly escalationHumanFallback?: string;
}

export interface PromptUnit {
  readonly id: PromptUnitId;
  readonly requires: readonly SessionCapability[];
  readonly render: (input: PromptPlanInput) => string | undefined;
}

export interface PromptPlanEntry {
  readonly unit: PromptUnitId;
  readonly text: string;
}

export interface PromptPlan {
  readonly entries: readonly PromptPlanEntry[];
  readonly text: string | undefined;
  readonly unresolved: readonly PromptUnitId[];
}

export const PROMPT_UNITS: readonly PromptUnit[] = [
  {
    id: 'space.agent.instructions',
    requires: [],
    render: (input) => input.instructions?.trim() || undefined,
  },
  {
    id: 'space.agent.goalOwner',
    requires: ['holds.goals'],
    render: (input) => input.ownerReviewContract,
  },
  {
    id: 'space.agent.scheduling',
    requires: ['holds.schedules'],
    render: (input) => input.schedulingGuardrail,
  },
  {
    id: 'space.agent.escalation',
    requires: ['responsibilities.escalation'],
    render: (input) => {
      if (!input.escalationHumanFallback) return undefined;
      return input.escalationTarget
        ? `Escalation: send_message to @${input.escalationTarget} for human/space-level judgment.`
        : input.escalationHumanFallback;
    },
  },
];

export function resolvePromptPlan(input: PromptPlanInput): PromptPlan {
  const held = new Set(input.profile.capabilities);
  const entries: PromptPlanEntry[] = [];
  const unresolved: PromptUnitId[] = [];
  for (const unit of PROMPT_UNITS) {
    if (!unit.requires.every((capability) => held.has(capability))) continue;
    const text = unit.render(input)?.trim();
    if (text) {
      entries.push({ unit: unit.id, text });
    } else {
      unresolved.push(unit.id);
    }
  }
  return { entries, text: joinPromptUnits(entries), unresolved };
}

export function joinPromptUnits(entries: readonly PromptPlanEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  return entries.map((entry) => entry.text).join('\n\n');
}
