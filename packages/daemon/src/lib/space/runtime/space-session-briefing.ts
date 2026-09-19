import { assembleSessionBriefing } from '../../briefings/assemble-session-briefing.ts';
import type { CapabilityContribution } from '../../briefings/contribution.ts';

export type SpaceSessionBriefingRole = 'long_term_agent' | 'ad_hoc_member';

export interface SpaceSessionBriefingInput {
  readonly spaceId: string;
  readonly spaceName: string;
  readonly role: SpaceSessionBriefingRole;
  readonly agentDisplayName?: string | null;
  readonly spaceInstructions?: string | null;
  readonly operations: CapabilityContribution;
}

function roleLine(input: SpaceSessionBriefingInput): string {
  const name = input.agentDisplayName?.trim();
  if (input.role === 'long_term_agent') {
    return name
      ? `Your role in it is the Space agent "${name}".`
      : 'Your role in it is one of its standing Space agents.';
  }
  return 'You are an ad-hoc member session: this Space has not assigned you an agent role.';
}

function spaceScopeBriefing(input: SpaceSessionBriefingInput): string {
  const sections = [
    '## Your Space',
    '',
    `You are working inside the Space "${input.spaceName}" (id: ${input.spaceId}) — a shared workspace with its own tasks, goals, agents, and workflows. ${roleLine(input)}`,
  ];
  const instructions = input.spaceInstructions?.trim();
  if (instructions) {
    sections.push('', '### Space Standing Instructions', '', instructions);
  }
  return sections.join('\n');
}

export function buildSpaceSessionBriefing(input: SpaceSessionBriefingInput): string {
  return assembleSessionBriefing({
    scope: [{ facet: 'space', briefing: spaceScopeBriefing(input) }],
    capabilities: [input.operations],
  }).text;
}
