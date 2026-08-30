import { useState, useEffect } from 'preact/hooks';
import type { SkillSourceType, AppSkillConfig } from '@hyperneo/shared';
import type { AppMcpServer } from '@hyperneo/shared';
import { skillsStore } from '../../lib/skills-store';
import { toast } from '../../lib/toast';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { connectionManager } from '../../lib/connection-manager';

function toSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface FormState {
  displayName: string;
  name: string;
  nameTouched: boolean;
  description: string;
  sourceType: SkillSourceType;
  commandName: string;
  pluginPath: string;
  appMcpServerId: string;
}

interface FormErrors {
  displayName?: string;
  name?: string;
  commandName?: string;
  pluginPath?: string;
  appMcpServerId?: string;
}

const EMPTY_FORM: FormState = {
  displayName: '',
  name: '',
  nameTouched: false,
  description: '',
  sourceType: 'builtin',
  commandName: '',
  pluginPath: '',
  appMcpServerId: '',
};

interface AddSkillDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AddSkillDialog({ isOpen, onClose }: AddSkillDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mcpServers, setMcpServers] = useState<AppMcpServer[]>([]);

  useEffect(() => {
    if (!isOpen || form.sourceType !== 'mcp_server') return;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    hub
      .request<{ servers: AppMcpServer[] }>('mcp.registry.list', {})
      .then((res) => setMcpServers(res.servers ?? []))
      .catch(() => setMcpServers([]));
  }, [isOpen, form.sourceType]);

  const handleDisplayNameChange = (value: string) => {
    setForm((f) => ({
      ...f,
      displayName: value,
      name: f.nameTouched ? f.name : toSlug(value),
    }));
  };

  const validate = (): boolean => {
    const errs: FormErrors = {};
    if (!form.displayName.trim()) {
      errs.displayName = 'Display Name is required';
    }
    if (!form.name.trim()) {
      errs.name = 'Name is required';
    } else if (!/^[a-z0-9-]+$/.test(form.name.trim())) {
      errs.name = 'Name must contain only lowercase letters, numbers, and hyphens';
    }
    if (form.sourceType === 'builtin' && !form.commandName.trim()) {
      errs.commandName = 'Command name is required for built-in skills';
    }
    if (form.sourceType === 'plugin' && !form.pluginPath.trim()) {
      errs.pluginPath = 'Plugin directory path is required';
    }
    if (form.sourceType === 'mcp_server' && !form.appMcpServerId) {
      errs.appMcpServerId = 'Please select an MCP server';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const buildConfig = (): AppSkillConfig => {
    switch (form.sourceType) {
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
      await skillsStore.addSkill({
        name: form.name.trim(),
        displayName: form.displayName.trim(),
        description: form.description.trim(),
        sourceType: form.sourceType,
        config: buildConfig(),
        enabled: true,
        validationStatus: 'pending',
      });
      toast.success(`Added "${form.displayName.trim()}"`);
      handleClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add skill');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setForm(EMPTY_FORM);
    setErrors({});
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Add Skill" size="md">
      <form onSubmit={handleSubmit} class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-fg-soft mb-1">
            Display Name <span class="text-danger">*</span>
          </label>
          <input
            type="text"
            value={form.displayName}
            onChange={(e) => handleDisplayNameChange((e.target as HTMLInputElement).value)}
            class={cn(
              'w-full bg-surface-raised border rounded-lg px-3 py-2 text-sm text-fg-soft',
              'focus:outline-none focus:ring-1 focus:ring-accent',
              errors.displayName ? 'border-danger' : 'border-line'
            )}
            placeholder="e.g., Web Search"
            autoFocus
          />
          {errors.displayName && <p class="text-xs text-danger mt-1">{errors.displayName}</p>}
        </div>

        <div>
          <label class="block text-sm font-medium text-fg-soft mb-1">
            Name <span class="text-danger">*</span>
          </label>
          <input
            type="text"
            value={form.name}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                name: (e.target as HTMLInputElement).value,
                nameTouched: true,
              }))
            }
            class={cn(
              'w-full bg-surface-raised border rounded-lg px-3 py-2 text-sm text-fg-soft font-mono',
              'focus:outline-none focus:ring-1 focus:ring-accent',
              errors.name ? 'border-danger' : 'border-line'
            )}
            placeholder="e.g., web-search"
          />
          {errors.name && <p class="text-xs text-danger mt-1">{errors.name}</p>}
          <p class="text-xs text-fg-faint mt-1">
            Unique slug identifier (auto-derived from display name)
          </p>
        </div>

        <div>
          <label class="block text-sm font-medium text-fg-soft mb-1">Description</label>
          <input
            type="text"
            value={form.description}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                description: (e.target as HTMLInputElement).value,
              }))
            }
            class="w-full bg-surface-raised border border-line rounded-lg px-3 py-2 text-sm text-fg-soft focus:outline-none focus:ring-1 focus:ring-accent"
            placeholder="Optional description of what this skill does"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-fg-soft mb-2">
            Source Type <span class="text-danger">*</span>
          </label>
          <div class="flex gap-6">
            {(['builtin', 'plugin', 'mcp_server'] as SkillSourceType[]).map((type) => (
              <label key={type} class="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="sourceType"
                  value={type}
                  checked={form.sourceType === type}
                  onChange={() => setForm((f) => ({ ...f, sourceType: type }))}
                  class="accent-blue-500"
                />
                <span class="text-sm text-fg-soft">
                  {type === 'builtin' ? 'Built-in' : type === 'plugin' ? 'Plugin' : 'MCP Server'}
                </span>
              </label>
            ))}
          </div>
        </div>

        {form.sourceType === 'builtin' && (
          <div>
            <label class="block text-sm font-medium text-fg-soft mb-1">
              Command Name <span class="text-danger">*</span>
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
                'w-full bg-surface-raised border rounded-lg px-3 py-2 text-sm text-fg-soft font-mono',
                'focus:outline-none focus:ring-1 focus:ring-accent',
                errors.commandName ? 'border-danger' : 'border-line'
              )}
              placeholder="e.g., update-config"
            />
            {errors.commandName && <p class="text-xs text-danger mt-1">{errors.commandName}</p>}
            <p class="text-xs text-fg-faint mt-1">
              The slash-command name in <code class="font-mono">.claude/commands/</code>
            </p>
          </div>
        )}

        {form.sourceType === 'plugin' && (
          <div>
            <label class="block text-sm font-medium text-fg-soft mb-1">
              Plugin Directory Path <span class="text-danger">*</span>
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
                'w-full bg-surface-raised border rounded-lg px-3 py-2 text-sm text-fg-soft font-mono',
                'focus:outline-none focus:ring-1 focus:ring-accent',
                errors.pluginPath ? 'border-danger' : 'border-line'
              )}
              placeholder="/path/to/plugin-directory"
            />
            {errors.pluginPath && <p class="text-xs text-danger mt-1">{errors.pluginPath}</p>}
            <p class="text-xs text-fg-faint mt-1">Absolute path to the plugin directory on disk</p>
          </div>
        )}

        {form.sourceType === 'mcp_server' && (
          <div>
            <label class="block text-sm font-medium text-fg-soft mb-1">
              MCP Server <span class="text-danger">*</span>
            </label>
            {mcpServers.length === 0 ? (
              <p class="text-xs text-fg-faint py-2">
                No application MCP servers configured. Add one in the{' '}
                <span class="text-fg-muted">MCP Servers</span> settings panel first.
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
                  'w-full bg-surface-raised border rounded-lg px-3 py-2 text-sm text-fg-soft',
                  'focus:outline-none focus:ring-1 focus:ring-accent',
                  errors.appMcpServerId ? 'border-danger' : 'border-line'
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
              <p class="text-xs text-danger mt-1">{errors.appMcpServerId}</p>
            )}
          </div>
        )}

        <div class="flex items-center justify-end gap-3 pt-2">
          <Button type="button" variant="secondary" size="sm" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={isSubmitting}>
            Add Skill
          </Button>
        </div>
      </form>
    </Modal>
  );
}
