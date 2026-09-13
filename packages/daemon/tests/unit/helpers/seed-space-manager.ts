import { getLongHorizonAgentTemplate } from '../../../src/lib/space/agents/long-horizon-agent-templates';
import {
  coordinatorLongHorizonAgentId,
  coordinatorSessionId,
  type SpaceLongHorizonAgentRepository,
} from '../../../src/storage/repositories/space-long-horizon-agent-repository';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';

export function seedSpaceManagerAgent(
  repo: SpaceLongHorizonAgentRepository,
  spaceId: string
): SpaceLongHorizonAgent {
  const template = getLongHorizonAgentTemplate('coordinator.default');
  return repo.create({
    id: coordinatorLongHorizonAgentId(spaceId),
    spaceId,
    handle: template?.handle ?? 'space-manager',
    displayName: template?.displayName ?? 'Space Manager',
    templateKey: template?.key ?? 'coordinator.default',
    status: 'active',
    sessionId: coordinatorSessionId(spaceId),
    instructions: template?.instructions ?? '',
    autonomyLevel: template?.suggestedAutonomyLevel,
    toolPermissions: template?.toolPermissions,
  });
}
