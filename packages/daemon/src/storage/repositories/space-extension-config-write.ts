import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { SpaceExternalEventSourceConfig } from '../../lib/external-events/types.ts';
import { persistSpaceExtensionConfig } from './space-extension-config-persist.ts';

class SpaceExtensionConfigWriter {
  constructor(private readonly db: Database) {}

  persist(
    spaceId: string,
    source: string,
    config: SpaceExternalEventSourceConfig,
    now: number
  ): void {
    persistSpaceExtensionConfig(this.db, spaceId, source, config, now);
  }
}

export const spaceExtensionConfigWrites = defineRepositoryOp(
  'extension.space.config.write',
  'write',
  SpaceExtensionConfigWriter,
  ['persist'] as const
);
