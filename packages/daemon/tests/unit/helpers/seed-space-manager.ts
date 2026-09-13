import {
  coordinatorLongHorizonAgentId,
  coordinatorSessionId,
  type SpaceLongHorizonAgentRepository,
} from '../../../src/storage/repositories/space-long-horizon-agent-repository';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';

const LEGACY_SPACE_MANAGER_INSTRUCTIONS =
  'Coordinate goals, tasks, reminders, event subscriptions, and Space activity.';

export function seedSpaceManagerAgent(
  repo: SpaceLongHorizonAgentRepository,
  spaceId: string
): SpaceLongHorizonAgent {
  return repo.create({
    id: coordinatorLongHorizonAgentId(spaceId),
    spaceId,
    handle: 'space-manager',
    displayName: 'Space Manager',
    templateKey: 'coordinator.default',
    status: 'active',
    sessionId: coordinatorSessionId(spaceId),
    instructions: LEGACY_SPACE_MANAGER_INSTRUCTIONS,
    autonomyLevel: 2,
  });
}
