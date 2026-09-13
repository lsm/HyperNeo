import {
  coordinatorLongHorizonAgentId,
  coordinatorSessionId,
  type SpaceLongHorizonAgentRepository,
} from '../../../src/storage/repositories/space-long-horizon-agent-repository';
import { LH_COORDINATOR_INSTRUCTIONS } from '@hyperneo/prompts';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';

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
    instructions: LH_COORDINATOR_INSTRUCTIONS,
    autonomyLevel: 2,
  });
}
