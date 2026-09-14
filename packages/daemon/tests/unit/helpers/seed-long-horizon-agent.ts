import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import type { SpaceLongHorizonAgentRepository } from '../../../src/storage/repositories/space-long-horizon-agent-repository';

export function seedLongHorizonAgent(
  repo: SpaceLongHorizonAgentRepository,
  spaceId: string
): SpaceLongHorizonAgent {
  return repo.create({
    id: `space-lh-agent:seeded:${spaceId}`,
    spaceId,
    handle: 'seeded-agent',
    displayName: 'Seeded Agent',
    templateKey: 'task-manager.default',
    status: 'active',
    sessionId: `space:lh-agent:${spaceId}:seeded`,
    instructions: 'Seeded long-horizon agent for repository tests.',
    autonomyLevel: 2,
  });
}
