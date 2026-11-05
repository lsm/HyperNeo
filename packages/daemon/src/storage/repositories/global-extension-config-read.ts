import superpipe, { type PipelineAPI } from 'superpipe';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { ExternalEventExtensionConfig } from '../../lib/external-events/types.ts';
import { lookupGlobalExtensionConfig } from './global-extension-config-lookup.ts';

const readGlobalConfig = (superpipe({})('extension-global-config-read') as PipelineAPI)
  .input(['db', 'source'])
  .pipe(lookupGlobalExtensionConfig, ['db', 'source'], 'config')
  .end('config') as (db: Database, source: string) => ExternalEventExtensionConfig;

export const globalExtensionConfigReads = defineDbOp({
  name: 'extension.global.config.read',
  mode: 'read',
  run: (db: Database, input: { source: string }) => readGlobalConfig(db, input.source),
});
