import { useState, useEffect } from 'preact/hooks';
import type { AppSkill, AppSkillConfig } from '@hyperneo/shared';
import type { AppMcpServer } from '@hyperneo/shared';
import { skillsStore } from '../../lib/skills-store';
import { toast } from '../../lib/toast';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { connectionManager } from '../../lib/connection-manager';

interface FormState {
  displayName: string;
  description: string;
  commandName: string;
  pluginPath: string;
  appMcpServerId: string;
}

interface FormErrors {
  displayName?: string;
  commandName?: string;
  pluginPath?: string;
  appMcpServerId?: string;
}

function formFromSkill(skill: AppSkill): FormState {
  const state: FormState = {
    displayName: skill.displayName,
    description: skill.description,
    commandName: '',
    pluginPath: '',
    appMcpServerId: '',
  };
  switch (skill.config.type) {
    case 'builtin':
      state.commandName = skill.config.commandName;
      break;
    case 'plugin':
      state.pluginPath = skill.config.pluginPath;
      break;
    case 'mcp_server':
      state.appMcpServerId = skill.config.appMcpServerId;
      break;
  }
  return state;
}

interface EditSkillDialogProps {
  skill: AppSkill;
  isOpen: boolean;
  onClose: () => void;
}

export function EditSkillDialog({ skill, isOpen, onClose }: EditSkillDialogProps) {
  const [form, setForm] = useState<FormState>(() => formFromSkill(skill));
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mcpServers, setMcpServers] = useState<AppMcpServer[]>([]);

  useEffect(() => {
    setForm(formFromSkill(skill));
    setErrors({});
  }, [skill.id]);

  useEffect(() => {
    if (!isOpen || skill.sourceType !== 'mcp_server') return;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    hub
      .request<{ servers: AppMcpServer[] }>('mcp.registry.list', {})
      .then((res) => setMcpServers(res.servers ?? []))
      .catch(() => setMcpServers([]));
  }, [isOpen, skill.sourceType]);

  const validate = (): boolean => {
    const errs: FormErrors = {};
    if (!form.displayName.trim()) {
      errs.displayName = 'Display Name is required';
    }
    if (skill.sourceType === 'builtin' && !form.commandName.trim()) {
      errs.commandName = 'Command name is required for built-in skills';
    }
    if (skill.sourceType === 'plugin' && !form.pluginPath.trim()) {
      errs.pluginPath = 'Plugin directory path is required';
    }
    if (skill.sourceType === 'mcp_server' && !form.appMcpServerId) {
      errs.appMcpServerId = 'Please select an MCP server';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const buildConfig = (): AppSkillConfig => {
    switch (skill.sourceType) {
      case 'builtin':
        return { type: 'builtin', commandName: form.commandName.trim() };
      case 'plugin':
        return { type: 'plugin', pluginPath: form.pluginPath.trim() };
      case 'mcp_server':
        return { type: 'mcp_server', appMcpServerId: form.appMcpServerId };
    }
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!validate()) return;
    setIsSubmitting(true);
    try {
      await skillsStore.updateSkill(skill.id, {
        displayName: form.displayName.trim(),
        description: form.description.trim(),
        config: buildConfig(),
      });
      toast.success(`Updated "${form.displayName.trim()}"`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update skill');
    } finally {
      setIsSubmitting(false);
    }
  };

  const createdDate = new Date(skill.createdAt).toLocaleString();

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit Skill" size="md">
      <form onSubmit={handleSubmit} class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-500 mb-1">ID</label>
            <div class="text-xs text-gray-400 font-mono bg-dark-900 border border-dark-700 rounded px-2 py-1.5 truncate">
              {skill.id}
            </div>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-500 mb-1">Created</label>
            <div class="text-xs text-gray-400 bg-dark-900 border border-dark-700 rounded px-2 py-1.5 truncate">
              {createdDate}
            </div>
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1">
            Display Name <span class="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={form.displayName}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                displayName: (e.target as HTMLInputElement).value,
              }))
            }
            class={cn(
              'w-full bg-dark-800 border rounded-lg px-3 py-2 text-sm text-gray-200',
              'focus:outline-none focus:ring-1 focus:ring-blue-500',
              errors.displayName ? 'border-red-500' : 'border-dark-700'
            )}
            autoFocus
          />
          {errors.displayName && <p class="text-xs text-red-400 mt-1">{errors.displayName}</p>}
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-500 mb-1">Name</label>
          <div class="text-sm text-gray-500 font-mono bg-dark-900 border border-dark-700 rounded-lg px-3 py-2">
            {skill.name}
          </div>
          <p class="text-xs text-gray-600 mt-1">Name cannot be changed after creation</p>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1">Description</label>
          <input
            type="text"
            value={form.description}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                description: (e.target as HTMLInputElement).value,
              }))
            }
            class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="Optional description"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-500 mb-1">Source Type</label>
          <div class="text-sm text-gray-500 bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 capitalize">
            {skill.sourceType === 'mcp_server'
              ? 'MCP Server'
              : skill.sourceType === 'builtin'
                ? 'Built-in'
                : 'Plugin'}
          </div>
        </div>

        {skill.sourceType === 'builtin' && (
          <div>
            <label class="block text-sm font-medium text-gray-300 mb-1">
              Command Name <span class="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={form.commandName}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  commandName: (e.target as HTMLInputElement).value,
                }))
              }
              class={cn(
                'w-full bg-dark-800 border rounded-lg px-3 py-2 text-sm text-gray-200 font-mono',
                'focus:outline-none focus:ring-1 focus:ring-blue-500',
                errors.commandName ? 'border-red-500' : 'border-dark-700'
              )}
              placeholder="e.g., update-config"
            />
            {errors.commandName && <p class="text-xs text-red-400 mt-1">{errors.commandName}</p>}
            <p class="text-xs text-gray-500 mt-1">
              The slash-command name in <code class="font-mono">.claude/commands/</code>
            </p>
          </div>
        )}

        {skill.sourceType === 'plugin' && (
          <div>
            <label class="block text-sm font-medium text-gray-300 mb-1">
              Plugin Directory Path <span class="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={form.pluginPath}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  pluginPath: (e.target as HTMLInputElement).value,
                }))
              }
              class={cn(
                'w-full bg-dark-800 border rounded-lg px-3 py-2 text-sm text-gray-200 font-mono',
                'focus:outline-none focus:ring-1 focus:ring-blue-500',
                errors.pluginPath ? 'border-red-500' : 'border-dark-700'
              )}
              placeholder="/path/to/plugin-directory"
            />
            {errors.pluginPath && <p class="text-xs text-red-400 mt-1">{errors.pluginPath}</p>}
            <p class="text-xs text-gray-500 mt-1">Absolute path to the plugin directory on disk</p>
          </div>
        )}

        {skill.sourceType === 'mcp_server' && (
          <div>
            <label class="block text-sm font-medium text-gray-300 mb-1">
              MCP Server <span class="text-red-400">*</span>
            </label>
            {mcpServers.length === 0 ? (
              <p class="text-xs text-gray-500 py-2">
                No application MCP servers configured. Add one in the{' '}
                <span class="text-gray-400">MCP Servers</span> settings panel first.
              </p>
            ) : (
              <select
                value={form.appMcpServerId}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    appMcpServerId: (e.target as HTMLSelectElement).value,
                  }))
                }
                class={cn(
                  'w-full bg-dark-800 border rounded-lg px-3 py-2 text-sm text-gray-200',
                  'focus:outline-none focus:ring-1 focus:ring-blue-500',
                  errors.appMcpServerId ? 'border-red-500' : 'border-dark-700'
                )}
              >
                <option value="">Select an MCP server…</option>
                {mcpServers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
            {errors.appMcpServerId && (
              <p class="text-xs text-red-400 mt-1">{errors.appMcpServerId}</p>
            )}
          </div>
        )}

        <div class="flex items-center justify-end gap-3 pt-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={isSubmitting}>
            Save Changes
          </Button>
        </div>
      </form>
    </Modal>
  );
}
