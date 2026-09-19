import { SPACE_OPERATIONS_DOOR } from '@hyperneo/prompts';

export type SpaceSessionBriefingRole = 'long_term_agent' | 'ad_hoc_member';

export interface SpaceSessionBriefingInput {
  readonly spaceId: string;
  readonly spaceName: string;
  readonly role: SpaceSessionBriefingRole;
  readonly agentDisplayName?: string | null;
  readonly spaceInstructions?: string | null;
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

export function buildSpaceSessionBriefing(input: SpaceSessionBriefingInput): string {
  const sections = [
    '## Your Space',
    '',
    `You are working inside the Space "${input.spaceName}" (id: ${input.spaceId}) — a shared workspace with its own tasks, goals, agents, and workflows. ${roleLine(input)}`,
    '',
    SPACE_OPERATIONS_DOOR,
  ];
  const instructions = input.spaceInstructions?.trim();
  if (instructions) {
    sections.push('', '### Space Standing Instructions', '', instructions);
  }
  return sections.join('\n');
}
