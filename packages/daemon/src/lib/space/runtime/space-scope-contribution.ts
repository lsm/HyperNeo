import type { ScopeContribution } from '../../briefings/contribution.ts';
import type { OperationCallerRole } from '../../operations/registry.ts';

export type SpaceScopeRole = Exclude<OperationCallerRole, 'universal_read' | 'outside_space'>;

export function spaceScopeRole(role: OperationCallerRole): SpaceScopeRole | null {
  switch (role) {
    case 'universal_read':
    case 'outside_space':
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
      return name
        ? `Your role in it is the Space agent "${name}".`
        : 'Your role in it is one of its standing Space agents.';
    }
    case 'workflow_worker':
      return 'Your role in it is a worker session running one node of a Space workflow for an assigned task.';
    case 'direct_task_worker':
      return 'Your role in it is a worker session running one assigned Space task directly, outside any workflow.';
    case 'legacy_task_agent':
      return 'Your role in it is a task agent session working the Space tasks assigned to it.';
    case 'ad_hoc_member':
      return 'You are an ad-hoc member session: this Space has not assigned you an agent role.';
  }
}

export function spaceScopeContribution(scope: SpaceSessionScope): ScopeContribution {
  const sections = [
    '## Your Space',
    '',
    `You are working inside the Space "${scope.spaceName}" (id: ${scope.spaceId}) — a shared workspace with its own tasks, goals, agents, and workflows. ${roleLine(scope)}`,
  ];
  const instructions = scope.spaceInstructions?.trim();
  if (instructions) {
    sections.push('', '### Space Standing Instructions', '', instructions);
  }
  return { facet: 'space', briefing: sections.join('\n') };
}
