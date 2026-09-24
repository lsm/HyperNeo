import type { Session } from '@hyperneo/shared';
import type { Database } from '../../../src/storage/sqlite-compat';
import { SpaceLongHorizonAgentRepository } from '../../../src/storage/repositories/space-long-horizon-agent-repository';

export function agentOwnedMetadata(
  db: Database,
  sessionId: string,
  spaceId: string | undefined,
  metadata: Session['metadata']
): Session['metadata'] {
  if (!spaceId || !db.prepare('SELECT 1 FROM spaces WHERE id = ?').get(spaceId)) return metadata;
  const agent = new SpaceLongHorizonAgentRepository(db).create({
    spaceId,
    handle: sessionId.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    sessionId,
  });
  return {
    ...metadata,
    promptProvenance: {
      source: 'test',
      hash: 'h',
      ...metadata.promptProvenance,
      agentId: agent.id,
    },
  } as Session['metadata'];
}
