import { globalExtensionConfigReads } from '../../storage/repositories/global-extension-config-read.ts';
import {
  lookupSpaceExtensionConfig,
  listEnabledSpaceExtensionConfigs,
} from '../../storage/repositories/space-extension-config-lookup.ts';
import { spaceExtensionConfigWrites } from '../../storage/repositories/space-extension-config-write.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { globalExtensionConfigWrites } from '../../storage/repositories/global-extension-config-write.ts';
import { isRecord } from '../record.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type {
  ExternalEventExtensionConfig,
  ExternalEventExtensionConfigStore as ExternalEventExtensionConfigStoreContract,
  SpaceExternalEventSourceConfig,
} from './types.ts';

export type { ExternalEventExtensionConfig, SpaceExternalEventSourceConfig } from './types.ts';

export class ExternalEventExtensionConfigStore
  implements ExternalEventExtensionConfigStoreContract
{
  constructor(private readonly db: BunDatabase) {}

  async getGlobalConfig(source: string): Promise<ExternalEventExtensionConfig> {
    validateSourceId(source);
    return gatewayFor(this.db).run(globalExtensionConfigReads, { source });
  }

  async getSpaceConfig(
    spaceId: string,
    source: string
  ): Promise<SpaceExternalEventSourceConfig | null> {
    validateSpaceId(spaceId);
    validateSourceId(source);
    return lookupSpaceExtensionConfig(this.db, spaceId, source);
  }

  async listEnabledSpaces(source: string): Promise<SpaceExternalEventSourceConfig[]> {
    validateSourceId(source);
    return listEnabledSpaceExtensionConfigs(this.db, source);
  }

  async setGlobalConfig(source: string, config: ExternalEventExtensionConfig): Promise<void> {
    validateSourceId(source);
    validateGlobalConfig(source, config);
    const now = Date.now();
    await gatewayFor(this.db).call(globalExtensionConfigWrites, 'persist', source, config, now);
  }

  async setSpaceConfig(
    spaceId: string,
    source: string,
    config: SpaceExternalEventSourceConfig
  ): Promise<void> {
    validateSpaceId(spaceId);
    validateSourceId(source);
    validateSpaceConfig(spaceId, source, config);
    const now = Date.now();
    await gatewayFor(this.db).call(
      spaceExtensionConfigWrites,
      'persist',
      spaceId,
      source,
      config,
      now
    );
  }
}

function validateGlobalConfig(source: string, config: ExternalEventExtensionConfig): void {
  if (config.source !== source) {
    throw new Error(
      `Global external-event config source "${config.source}" must match "${source}"`
    );
  }
  if (!isRecord(config.capabilities)) {
    throw new Error('Global external-event config capabilities must be an object');
  }
  if (config.settings !== undefined && !isRecord(config.settings)) {
    throw new Error('Global external-event config settings must be an object when present');
  }
}

function validateSpaceConfig(
  spaceId: string,
  source: string,
  config: SpaceExternalEventSourceConfig
): void {
  if (config.spaceId !== spaceId) {
    throw new Error(
      `Space external-event config spaceId "${config.spaceId}" must match "${spaceId}"`
    );
  }
  if (config.source !== source) {
    throw new Error(`Space external-event config source "${config.source}" must match "${source}"`);
  }
  if (!isRecord(config.settings)) {
    throw new Error('Space external-event config settings must be an object');
  }
}

function validateSourceId(source: string): void {
  if (!source || source.trim().length === 0 || source !== source.trim()) {
    throw new Error('External event source must be non-empty and must not include edge whitespace');
  }
}

function validateSpaceId(spaceId: string): void {
  if (!spaceId || spaceId.trim().length === 0 || spaceId !== spaceId.trim()) {
    throw new Error('Space id must be non-empty and must not include edge whitespace');
  }
}
