import { useState } from 'preact/hooks';
import type { AppSkill } from '@hyperneo/shared';
import { useSkills } from '../../hooks/useSkills';
import { skillsStore } from '../../lib/skills-store';
import { toast } from '../../lib/toast';
import { SettingsSection, SettingsToggle } from './SettingsSection';
import { ConfirmModal } from '../ui/ConfirmModal';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { AddSkillDialog } from './AddSkillDialog';
import { EditSkillDialog } from './EditSkillDialog';
import { InstallSkillFromGitDialog } from './InstallSkillFromGitDialog';

const SOURCE_TYPE_STYLES: Record<string, string> = {
  builtin: 'bg-green-500/20 text-green-400',
  plugin: 'bg-blue-500/20 text-blue-400',
  mcp_server: 'bg-purple-500/20 text-purple-400',
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  builtin: 'built-in',
  plugin: 'plugin',
  mcp_server: 'mcp',
};

export function SkillsRegistry() {
  const { skills: skillsList, isLoading: isLoadingVal, error: errorVal } = useSkills();

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showInstallFromGitDialog, setShowInstallFromGitDialog] = useState(false);
  const [editingSkill, setEditingSkill] = useState<AppSkill | null>(null);
  const [deletingSkill, setDeletingSkill] = useState<AppSkill | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!deletingSkill) return;
    setIsDeleting(true);
    try {
      await skillsStore.removeSkill(deletingSkill.id);
      toast.success(`Deleted "${deletingSkill.displayName}"`);
      setShowDeleteConfirm(false);
      setDeletingSkill(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete skill');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleToggle = async (skill: AppSkill, enabled: boolean) => {
    setTogglingId(skill.id);
    try {
      await skillsStore.setEnabled(skill.id, enabled);
      toast.success(`${enabled ? 'Enabled' : 'Disabled'} "${skill.displayName}"`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Failed to ${enabled ? 'enable' : 'disable'} skill`
      );
    } finally {
      setTogglingId(null);
    }
  };

  if (isLoadingVal && skillsList.length === 0) {
    return (
      <SettingsSection title="Skills">
        <div class="text-sm text-gray-500 py-2">Loading skills...</div>
      </SettingsSection>
    );
  }

  if (errorVal) {
    return (
      <SettingsSection title="Skills">
        <div class="text-sm text-red-400 py-2">Error: {errorVal}</div>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title="Skills">
        <div class="mb-4">
          <p class="text-xs text-gray-500 mb-3">
            Application-level skills are available to any space or session. Built-in skills ship
            with HyperNeo; plugin and MCP server skills can be added from external sources.
          </p>
          <div class="flex gap-2">
            <Button variant="primary" size="sm" onClick={() => setShowAddDialog(true)}>
              Add Skill
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setShowInstallFromGitDialog(true)}>
              Install from Git
            </Button>
          </div>
        </div>

        {skillsList.length === 0 ? (
          <div class="text-sm text-gray-500 py-4">No skills added yet. Add your first skill.</div>
        ) : (
          <div class="space-y-2">
            {skillsList.map((skill) => (
              <div
                key={skill.id}
                class={cn(
                  'flex items-center justify-between gap-3 py-3 px-3',
                  'bg-dark-800/50 rounded-lg border border-dark-700'
                )}
              >
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <div class="text-sm text-gray-200 font-medium truncate">
                      {skill.displayName}
                    </div>
                    <span
                      class={cn(
                        'px-1.5 py-0.5 rounded text-[10px] uppercase font-medium',
                        SOURCE_TYPE_STYLES[skill.sourceType] ?? 'bg-gray-500/20 text-gray-400'
                      )}
                    >
                      {SOURCE_TYPE_LABELS[skill.sourceType] ?? skill.sourceType}
                    </span>
                    {skill.builtIn && (
                      <span class="px-1.5 py-0.5 rounded text-[10px] bg-yellow-500/20 text-yellow-400 uppercase font-medium">
                        system
                      </span>
                    )}
                  </div>
                  {skill.description && (
                    <div class="text-xs text-gray-500 mt-1 truncate">{skill.description}</div>
                  )}
                </div>

                <div class="flex items-center gap-2 flex-shrink-0">
                  {!skill.builtIn && (
                    <button
                      onClick={() => setEditingSkill(skill)}
                      class="p-1.5 text-gray-400 hover:text-gray-200 hover:bg-dark-700 rounded transition-colors"
                      title="Edit"
                    >
                      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width={2}
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                        />
                      </svg>
                    </button>
                  )}
                  {!skill.builtIn && (
                    <button
                      onClick={() => {
                        setDeletingSkill(skill);
                        setShowDeleteConfirm(true);
                      }}
                      class="p-1.5 text-gray-400 hover:text-red-400 hover:bg-dark-700 rounded transition-colors"
                      title="Delete"
                    >
                      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </button>
                  )}
                  <SettingsToggle
                    checked={skill.enabled}
                    onChange={(enabled) => handleToggle(skill, enabled)}
                    disabled={togglingId === skill.id}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <AddSkillDialog isOpen={showAddDialog} onClose={() => setShowAddDialog(false)} />

      <InstallSkillFromGitDialog
        isOpen={showInstallFromGitDialog}
        onClose={() => setShowInstallFromGitDialog(false)}
      />

      {editingSkill && (
        <EditSkillDialog skill={editingSkill} isOpen onClose={() => setEditingSkill(null)} />
      )}

      <ConfirmModal
        isOpen={showDeleteConfirm}
        onClose={() => {
          setShowDeleteConfirm(false);
          setDeletingSkill(null);
        }}
        onConfirm={handleDelete}
        title="Delete Skill"
        message={`Are you sure you want to delete "${deletingSkill?.displayName}"? This action cannot be undone.`}
        confirmText="Delete"
        confirmButtonVariant="danger"
        isLoading={isDeleting}
      />
    </>
  );
}
