import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { ExternalEventExtensionConfig } from '../../lib/external-events/types.ts';
import { persistGlobalExtensionConfig } from './global-extension-config-persist.ts';

class GlobalExtensionConfigWriter {
  constructor(private readonly db: Database) {}

  persist(source: string, config: ExternalEventExtensionConfig, now: number): void {
    persistGlobalExtensionConfig(this.db, source, config, now);
  }
}

export const globalExtensionConfigWrites = defineRepositoryOp(
  'extension.global.config.write',
  'write',
  GlobalExtensionConfigWriter,
  ['persist'] as const
);
