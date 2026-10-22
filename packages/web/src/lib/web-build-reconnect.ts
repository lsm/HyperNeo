import type { MessageHub } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { invokeOperation } from './operations';

export const reloadStaleWebBuild = (superpipe({})('web-build-reconnect') as PipelineAPI)
  .input(['hub', 'bundleCommit', 'reload'])
  .pipe(
    (hub: MessageHub) => invokeOperation<{ commit?: string }>(hub, 'system.build', {}),
    'hub',
    'build'
  )
  .pipe(
    (build: { commit?: string }, bundleCommit: string) =>
      /^[0-9a-f]{40}$/.test(bundleCommit) &&
      /^[0-9a-f]{40}$/.test(build.commit ?? '') &&
      build.commit !== bundleCommit,
    ['build', 'bundleCommit'],
    'changed'
  )
  .pipe(
    (changed: boolean, reload: () => void) => {
      if (changed) reload();
    },
    ['changed', 'reload']
  )
  .endAsync('changed') as (
  hub: MessageHub,
  bundleCommit: string,
  reload: () => void
) => Promise<boolean>;
