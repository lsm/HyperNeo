import { access, constants } from 'node:fs/promises';
import type { Job } from '../../storage/repositories/job-queue-repository';
import type { SkillsManager } from '../skills-manager';
import type { AppMcpServerRepository } from '../../storage/repositories/app-mcp-server-repository';
import { isPluginSkillConfig, isMcpServerSkillConfig } from '@hyperneo/shared';

export interface SkillValidateResult extends Record<string, unknown> {
  valid: boolean;
  skillId: string;
}

export function createSkillValidateHandler(
  skillsManager: SkillsManager,
  appMcpServerRepo: AppMcpServerRepository
) {
  return async function handleSkillValidate(job: Job): Promise<SkillValidateResult> {
    const { skillId } = job.payload as { skillId: string };

    if (!skillId || typeof skillId !== 'string') {
      throw new Error('Job payload missing required field: skillId');
    }

    const skill = skillsManager.getSkill(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    try {
      if (isPluginSkillConfig(skill.config)) {
        await access(skill.config.pluginPath, constants.R_OK);
      } else if (isMcpServerSkillConfig(skill.config)) {
        const server = appMcpServerRepo.get(skill.config.appMcpServerId);
        if (!server) {
          throw new Error(
            `mcp_server skill "${skill.name}": app_mcp_servers entry not found for id "${skill.config.appMcpServerId}"`
          );
        }
      }

      skillsManager.setSkillValidationStatus(skillId, 'valid');
      return { valid: true, skillId };
    } catch (error) {
      skillsManager.setSkillValidationStatus(skillId, 'invalid');
      throw error;
    }
  };
}
