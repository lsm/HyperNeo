import superpipe, { type PipelineAPI } from 'superpipe';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { SpaceExternalEventSourceConfig } from '../../lib/external-events/types.ts';
import {
  lookupSpaceExtensionConfig,
  listEnabledSpaceExtensionConfigs,
} from './space-extension-config-lookup.ts';

function querySpaceConfig(db: Database, spaceId: string, source: string) {
  return { config: lookupSpaceExtensionConfig(db, spaceId, source) };
}

const readSpaceConfig = (superpipe({})('extension-space-config-read') as PipelineAPI)
  .input(['db', 'spaceId', 'source'])
  .pipe(querySpaceConfig, ['db', 'spaceId', 'source'], '{config}')
  .end('config') as (
  db: Database,
  spaceId: string,
  source: string
) => SpaceExternalEventSourceConfig | null;

const readEnabledSpaces = (superpipe({})('extension-space-enabled-read') as PipelineAPI)
  .input(['db', 'source'])
  .pipe(listEnabledSpaceExtensionConfigs, ['db', 'source'], 'configs')
  .end('configs') as (db: Database, source: string) => SpaceExternalEventSourceConfig[];

export const spaceExtensionConfigReads = defineDbOp({
  name: 'extension.space.config.read',
  mode: 'read',
  run: (db: Database, input: { spaceId: string; source: string }) =>
    readSpaceConfig(db, input.spaceId, input.source),
});

export const enabledSpaceExtensionConfigReads = defineDbOp({
  name: 'extension.space.enabled.read',
  mode: 'read',
  run: (db: Database, input: { source: string }) => readEnabledSpaces(db, input.source),
});
