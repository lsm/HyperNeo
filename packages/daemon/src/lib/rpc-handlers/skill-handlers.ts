/**
 * Skills RPC Handlers
 *
 * Exposes the application-level Skills registry via RPC:
 * - skill.list           — list all skills
 * - skill.get            — get a single skill by id
 * - skill.create         — add a new skill, emit skills.changed
 * - skill.update         — update a skill, emit skills.changed
 * - skill.delete         — remove a skill, emit skills.changed
 * - skill.setEnabled     — toggle enabled flag, emit skills.changed
 * - skill.installFromGit — install a skill from a git repository URL, emit skills.changed
 */

import type { MessageHub } from '@hyperneo/shared';
import type {
  AppSkill,
  CreateSkillParams,
  UpdateSkillParams,
  InstallSkillFromGitParams,
} from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SkillsManager } from '../skills-manager';
import { Logger } from '../logger';

const log = new Logger('skill-handlers');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitChanged(internalEventBus: InternalEventBus<DaemonInternalEventMap>): void {
  internalEventBus.publish('skills.changed', { sessionId: 'global' }).catch((err) => {
    log.warn('Failed to emit skills.changed:', err);
  });
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerSkillHandlers(
  messageHub: MessageHub,
  skillsManager: SkillsManager,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  workspaceRoot?: string
): void {
  // skill.list — returns AppSkill[]
  messageHub.onRequest('skill.list', async () => {
    const skills = skillsManager.listSkills();
    return { skills } satisfies { skills: AppSkill[] };
  });

  // skill.get — fetch a single skill by id
  messageHub.onRequest('skill.get', async (data) => {
    const { id } = data as { id: string };

    if (!id) {
      throw new Error('id is required');
    }

    const skill = skillsManager.getSkill(id);
    return { skill } satisfies { skill: AppSkill | null };
  });

  // skill.create — validates input via SkillsManager, creates skill, emits event
  messageHub.onRequest('skill.create', async (data) => {
    const { params } = data as { params: CreateSkillParams };

    if (!params) {
      throw new Error('params is required');
    }

    const skill = skillsManager.addSkill(params);
    emitChanged(internalEventBus);
    log.info(`skill.create: created "${skill.name}" (${skill.id})`);
    return { skill } satisfies { skill: AppSkill };
  });

  // skill.update — updates skill, emits event, returns updated skill
  messageHub.onRequest('skill.update', async (data) => {
    const { id, params } = data as { id: string; params: UpdateSkillParams };

    if (!id) {
      throw new Error('id is required');
    }
    if (!params) {
      throw new Error('params is required');
    }

    const skill = skillsManager.updateSkill(id, params);
    emitChanged(internalEventBus);
    log.info(`skill.update: updated "${skill.name}" (${id})`);
    return { skill } satisfies { skill: AppSkill };
  });

  // skill.delete — removes skill, emits event
  messageHub.onRequest('skill.delete', async (data) => {
    const { id } = data as { id: string };

    if (!id) {
      throw new Error('id is required');
    }

    const removed = skillsManager.removeSkill(id);
    if (!removed) {
      throw new Error(`Skill not found or cannot be removed: ${id}`);
    }

    emitChanged(internalEventBus);
    log.info(`skill.delete: deleted ${id}`);
    return { success: true } satisfies { success: boolean };
  });

  // skill.setEnabled — convenience toggle for the enabled field
  messageHub.onRequest('skill.setEnabled', async (data) => {
    const { id, enabled } = data as { id: string; enabled: boolean };

    if (!id) {
      throw new Error('id is required');
    }
    if (typeof enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }

    const skill = skillsManager.setSkillEnabled(id, enabled);
    emitChanged(internalEventBus);
    log.info(`skill.setEnabled: set ${id} enabled=${enabled}`);
    return { skill } satisfies { skill: AppSkill };
  });

  // skill.installFromGit — fetch a SKILL.md from a git repo URL and register it
  messageHub.onRequest('skill.installFromGit', async (data) => {
    const { repoUrl, commandName } = data as InstallSkillFromGitParams;

    if (!repoUrl) {
      throw new Error('skill.installFromGit requires repoUrl');
    }
    if (!commandName) {
      throw new Error('skill.installFromGit requires commandName');
    }

    const skill = await skillsManager.installSkillFromGit(repoUrl, commandName, workspaceRoot);
    emitChanged(internalEventBus);
    log.info(`skill.installFromGit: installed "${skill.name}" from ${repoUrl}`);
    return { skill } satisfies { skill: AppSkill };
  });
}
