import {
  fillPrompt,
  SPACE_SCOPE_BRIEFING,
  SPACE_SCOPE_ROLE_AGENT,
  SPACE_SCOPE_ROLE_DIRECT_WORKER,
  SPACE_SCOPE_ROLE_NAMED_AGENT,
  SPACE_SCOPE_ROLE_WORKFLOW_WORKER,
  SPACE_SCOPE_STANDING_INSTRUCTIONS,
} from '@hyperneo/prompts';
import type { ScopeContribution } from '../../briefings/contribution.ts';
import type { OperationCallerRole } from '../../operations/registry.ts';

export type SpaceScopeRole = Exclude<OperationCallerRole, 'universal_read' | 'neo'>;

export function spaceScopeRole(role: OperationCallerRole): SpaceScopeRole | null {
  switch (role) {
    case 'universal_read':
    case 'neo':
      return null;
    default:
      return role;
  }
}

export interface SpaceSessionScope {
  readonly spaceId: string;
  readonly spaceName: string;
  readonly role: SpaceScopeRole;
  readonly agentDisplayName?: string | null;
  readonly spaceInstructions?: string | null;
}

function roleLine(scope: SpaceSessionScope): string {
  switch (scope.role) {
    case 'long_term_agent': {
      const name = scope.agentDisplayName?.trim();
      return name ? fillPrompt(SPACE_SCOPE_ROLE_NAMED_AGENT, { name }) : SPACE_SCOPE_ROLE_AGENT;
    }
    case 'workflow_worker':
      return SPACE_SCOPE_ROLE_WORKFLOW_WORKER;
    case 'direct_task_worker':
      return SPACE_SCOPE_ROLE_DIRECT_WORKER;
  }
}

export function spaceScopeContribution(scope: SpaceSessionScope): ScopeContribution {
  const sections = [
    fillPrompt(SPACE_SCOPE_BRIEFING, {
      space_name: scope.spaceName,
      space_id: scope.spaceId,
      role: roleLine(scope),
    }),
  ];
  const instructions = scope.spaceInstructions?.trim();
  if (instructions) {
    sections.push('', fillPrompt(SPACE_SCOPE_STANDING_INSTRUCTIONS, { instructions }));
  }
  return { facet: 'space', briefing: sections.join('\n') };
}
