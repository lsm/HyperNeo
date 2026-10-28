import superpipe, { type PipelineAPI } from 'superpipe';
import type { AppSkill } from '@hyperneo/shared';
import type { SessionToolChoiceKey } from '@hyperneo/shared/types/session-tool-choice';
import { globalStore } from './global-store';
import { skillsStore } from './skills-store';
import { setAppMcpServerEnabled } from './api-helpers';

export function catalogSkillChoiceKey(skill: AppSkill): SessionToolChoiceKey {
  return skill.config.type === 'mcp_server'
    ? `mcp:${skill.config.appMcpServerId}`
    : `skill:${skill.id}`;
}

export const saveCatalogToolDefault = (superpipe({})('save-catalog-tool-default') as PipelineAPI)
  .input(['key', 'selected'])
  .pipe(
    (key: SessionToolChoiceKey, selected: boolean) =>
      key.startsWith('mcp:')
        ? setAppMcpServerEnabled(key.slice(4), selected)
        : skillsStore.setEnabled(key.slice(6), selected),
    ['key', 'selected'],
    'saved'
  )
  .pipe(
    () =>
      globalStore.refresh().catch(() => {
        throw new Error('Default saved, but could not refresh it. Reload to see the saved choice.');
      }),
    'saved',
    'refreshed'
  )
  .endAsync('refreshed') as (key: SessionToolChoiceKey, selected: boolean) => Promise<void>;
