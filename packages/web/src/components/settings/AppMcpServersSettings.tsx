import { useEffect, useMemo, useState } from 'preact/hooks';
import type { AppMcpServer, AppMcpServerSourceType } from '@hyperneo/shared';
import {
  createAppMcpServer,
  updateAppMcpServer,
  deleteAppMcpServer,
  setAppMcpServerEnabled,
} from '../../lib/api-helpers.ts';
import { appMcpStore } from '../../lib/app-mcp-store.ts';
import { skillsStore } from '../../lib/skills-store.ts';
import { toast } from '../../lib/toast.ts';
import { SettingsSection, SettingsToggle } from './SettingsSection.tsx';
import { Modal } from '../ui/Modal.tsx';
import { ConfirmModal } from '../ui/ConfirmModal.tsx';
import { Button } from '../ui/Button.tsx';
import { cn } from '../../lib/utils.ts';
import { computeMcpServerSkillLinkage } from '../ToolsModal.utils.ts';

interface FormData {
  name: string;
  description: string;
  sourceType: AppMcpServerSourceType;
  command: string;
  args: string;
  envVars: string;
  url: string;
  headers: string;
}

interface FormErrors {
  name?: string;
  sourceType?: string;
  command?: string;
  args?: string;
  envVars?: string;
  url?: string;
  headers?: string;
}

const EMPTY_FORM: FormData = {
  name: '',
  description: '',
  sourceType: 'stdio',
  command: '',
  args: '',
  envVars: '',
  url: '',
  headers: '',
};

export function AppMcpServersSettings() {
  const servers = appMcpStore.appMcpServers.value;
  const loading = appMcpStore.loading.value;
  const error = appMcpStore.error.value;
  const skills = skillsStore.skills.value;
  const skillsLoaded = skillsStore.loaded.value;

  const [showForm, setShowForm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editingServer, setEditingServer] = useState<AppMcpServer | null>(null);
  const [deletingServer, setDeletingServer] = useState<AppMcpServer | null>(null);
  const [formData, setFormData] = useState<FormData>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    appMcpStore.subscribe().catch((err) => {
      toast.error(
        'Failed to load MCP servers: ' + (err instanceof Error ? err.message : 'Unknown error')
      );
    });
    skillsStore.subscribe().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(
        'Failed to load skills for MCP linkage:',
        err instanceof Error ? err.message : err
      );
    });

    return () => {
      appMcpStore.unsubscribe();
      skillsStore.unsubscribe();
    };
  }, []);

  const skillLinkage = useMemo(() => computeMcpServerSkillLinkage(skills), [skills]);

  const validateForm = (): boolean => {
    const errors: FormErrors = {};

    if (!formData.name.trim()) {
      errors.name = 'Name is required';
    }

    if (formData.sourceType === 'stdio') {
      if (!formData.command.trim()) {
        errors.command = 'Command is required for stdio servers';
      }
    } else {
      if (!formData.url.trim()) {
        errors.url = 'URL is required for SSE/HTTP servers';
      } else if (!/^https?:\/\//i.test(formData.url.trim())) {
        errors.url = 'URL must start with http:// or https://';
      }
    }

    if (formData.args.trim()) {
      const args = formData.args.trim().split(/\s+/);
      if (args.some((a) => a.includes('"'))) {
        errors.args = 'Args should be space-separated without quotes';
      }
    }

    if (formData.envVars.trim()) {
      const lines = formData.envVars.trim().split('\n');
      for (const line of lines) {
        if (!line.includes('=')) {
          errors.envVars = 'Each env var must be in key=value format';
          break;
        }
        const [key] = line.split('=');
        if (!key.trim()) {
          errors.envVars = 'Each env var must be in key=value format';
          break;
        }
      }
    }

    if (formData.headers.trim()) {
      const lines = formData.headers.trim().split('\n');
      for (const line of lines) {
        if (!line.includes('=')) {
          errors.headers = 'Each header must be in key=value format';
          break;
        }
        const [key] = line.split('=');
        if (!key.trim()) {
          errors.headers = 'Each header must be in key=value format';
          break;
        }
      }
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const resetForm = () => {
    setFormData(EMPTY_FORM);
    setFormErrors({});
    setEditingServer(null);
  };

  const openAddForm = () => {
    resetForm();
    setShowForm(true);
  };

  const openEditForm = (server: AppMcpServer) => {
    setEditingServer(server);
    setFormData({
      name: server.name,
      description: server.description ?? '',
      sourceType: server.sourceType,
      command: server.command ?? '',
      args: server.args?.join(' ') ?? '',
      envVars: server.env
        ? Object.entries(server.env)
            .map(([k, v]) => `${k}=${v}`)
            .join('\n')
        : '',
      url: server.url ?? '',
      headers: server.headers
        ? Object.entries(server.headers)
            .map(([k, v]) => `${k}=${v}`)
            .join('\n')
        : '',
    });
    setFormErrors({});
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    resetForm();
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();

    if (!validateForm()) return;

    setIsSubmitting(true);

    try {
      const parsedArgs = formData.args.trim() ? formData.args.trim().split(/\s+/) : undefined;
      const parsedEnv = formData.envVars.trim()
        ? Object.fromEntries(
            formData.envVars
              .trim()
              .split('\n')
              .map((line) => {
                const [key, ...valueParts] = line.split('=');
                return [key.trim(), valueParts.join('=')];
              })
          )
        : undefined;
      const parsedHeaders = formData.headers.trim()
        ? Object.fromEntries(
            formData.headers
              .trim()
              .split('\n')
              .map((line) => {
                const [key, ...valueParts] = line.split('=');
                return [key.trim(), valueParts.join('=')];
              })
          )
        : undefined;

      if (editingServer) {
        await updateAppMcpServer(editingServer.id, {
          name: formData.name.trim(),
          description: formData.description.trim() || undefined,
          sourceType: formData.sourceType,
          command:
            formData.sourceType === 'stdio' ? formData.command.trim() || undefined : undefined,
          args: formData.sourceType === 'stdio' ? parsedArgs : undefined,
          env: parsedEnv,
          url: formData.sourceType !== 'stdio' ? formData.url.trim() || undefined : undefined,
          headers: formData.sourceType !== 'stdio' ? parsedHeaders : undefined,
        });
        toast.success(`Updated "${formData.name}"`);
      } else {
        await createAppMcpServer({
          name: formData.name.trim(),
          description: formData.description.trim() || undefined,
          sourceType: formData.sourceType,
          command:
            formData.sourceType === 'stdio' ? formData.command.trim() || undefined : undefined,
          args: formData.sourceType === 'stdio' ? parsedArgs : undefined,
          env: parsedEnv,
          url: formData.sourceType !== 'stdio' ? formData.url.trim() || undefined : undefined,
          headers: formData.sourceType !== 'stdio' ? parsedHeaders : undefined,
        });
        toast.success(`Added "${formData.name}"`);
      }

      closeForm();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save MCP server';
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingServer) return;

    setIsSubmitting(true);
    try {
      await deleteAppMcpServer(deletingServer.id);
      toast.success(`Deleted "${deletingServer.name}"`);
      setShowDeleteConfirm(false);
      setDeletingServer(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete MCP server';
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggle = async (server: AppMcpServer, enabled: boolean) => {
    setTogglingId(server.id);
    try {
      await setAppMcpServerEnabled(server.id, enabled);
      toast.success(`${enabled ? 'Enabled' : 'Disabled'} "${server.name}"`);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : `Failed to ${enabled ? 'enable' : 'disable'} MCP server`;
      toast.error(message);
    } finally {
      setTogglingId(null);
    }
  };

  if (loading && servers.length === 0) {
    return (
      <SettingsSection title="MCP Servers">
        <div class="text-sm text-fg-faint py-2">Loading servers...</div>
      </SettingsSection>
    );
  }

  if (error) {
    return (
      <SettingsSection title="MCP Servers">
        <div class="text-sm text-danger py-2">Error: {error}</div>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title="MCP Servers">
        <div class="mb-4">
          <p class="text-xs text-fg-faint mb-3">
            MCP servers are available to any space or session. Configure external MCP servers here.
            For API keys and secrets, set them in your system environment (e.g.,{' '}
            <code class="text-xs bg-surface-raised px-1 py-0.5 rounded">export MY_API_KEY=...</code>
            ) and reference them by name in the env vars field below. Values stored here are saved
            in plain text.
          </p>
          <Button variant="primary" size="sm" onClick={openAddForm}>
            Add MCP Server
          </Button>
        </div>

        {servers.length === 0 ? (
          <div class="text-sm text-fg-faint py-4">
            No MCP servers configured. Click "Add MCP Server" to add one.
          </div>
        ) : (
          <div class="space-y-2">
            {servers.map((server) => {
              const linkedSkill = skillLinkage.get(server.id);
              return (
                <div
                  key={server.id}
                  class={cn(
                    'flex items-center justify-between gap-3 py-3 px-3',
                    'bg-surface-raised/50 rounded-lg border border-line'
                  )}
                >
                  <div class="flex-1 min-w-0">
                    <div class="text-sm text-fg-soft truncate font-medium">{server.name}</div>
                    <div class="text-xs text-fg-faint mt-0.5 flex items-center gap-2 flex-wrap">
                      <span
                        class={cn(
                          'px-1.5 py-0.5 rounded text-[10px] uppercase font-medium',
                          server.sourceType === 'stdio' && 'bg-success/20 text-success',
                          server.sourceType === 'sse' && 'bg-accent/20 text-accent',
                          server.sourceType === 'http' && 'bg-cat-purple/20 text-cat-purple'
                        )}
                      >
                        {server.sourceType}
                      </span>
                      {server.sourceType === 'stdio' && server.command && (
                        <span class="font-mono truncate max-w-[200px]">{server.command}</span>
                      )}
                      {server.sourceType !== 'stdio' && server.url && (
                        <span class="truncate max-w-[200px]">{server.url}</span>
                      )}
                    </div>
                    {server.description && (
                      <div class="text-xs text-fg-faint mt-1 truncate">{server.description}</div>
                    )}
                    {skillsLoaded && linkedSkill && (
                      <div
                        class="text-[11px] text-info/80 mt-1 truncate"
                        data-testid={`skill-link-${server.name}`}
                      >
                        Exposed to sessions via the{' '}
                        <span class="font-medium">{linkedSkill.displayName}</span> skill
                        {!linkedSkill.enabled && ' (skill is off)'}
                      </div>
                    )}
                    {skillsLoaded && !linkedSkill && (
                      <div
                        class="text-[11px] text-warning/90 mt-1"
                        data-testid={`skill-orphan-${server.name}`}
                      >
                        ⚠️ No skill wrapper — this server is not injected into any session. Toggling
                        it here has no runtime effect.
                      </div>
                    )}
                  </div>

                  <div class="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => openEditForm(server)}
                      class="p-1.5 text-fg-muted hover:text-fg-soft hover:bg-fill-strong rounded transition-colors"
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
                    <button
                      onClick={() => {
                        setDeletingServer(server);
                        setShowDeleteConfirm(true);
                      }}
                      class="p-1.5 text-fg-muted hover:text-danger hover:bg-fill-strong rounded transition-colors"
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
                    <SettingsToggle
                      checked={server.enabled}
                      onChange={(enabled) => handleToggle(server, enabled)}
                      disabled={togglingId === server.id}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <Modal
        isOpen={showForm}
        onClose={closeForm}
        title={editingServer ? 'Edit MCP Server' : 'Add MCP Server'}
        size="lg"
      >
        <form onSubmit={handleSubmit} class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-fg-soft mb-1">
              Name <span class="text-danger">*</span>
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: (e.target as HTMLInputElement).value })
              }
              class={cn(
                'w-full bg-surface-raised border rounded-lg px-3 py-2 text-sm text-fg-soft',
                'focus:outline-none focus:ring-1 focus:ring-accent',
                formErrors.name ? 'border-danger' : 'border-line'
              )}
              placeholder="e.g., my-mcp-server"
            />
            {formErrors.name && <p class="text-xs text-danger mt-1">{formErrors.name}</p>}
          </div>

          <div>
            <label class="block text-sm font-medium text-fg-soft mb-1">Description</label>
            <input
              type="text"
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: (e.target as HTMLInputElement).value })
              }
              class="w-full bg-surface-raised border border-line rounded-lg px-3 py-2 text-sm text-fg-soft focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="Optional description"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-fg-soft mb-1">
              Source Type <span class="text-danger">*</span>
            </label>
            <select
              value={formData.sourceType}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  sourceType: (e.target as HTMLSelectElement).value as AppMcpServerSourceType,
                })
              }
              class="w-full bg-surface-raised border border-line rounded-lg px-3 py-2 text-sm text-fg-soft focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="stdio">Stdio (local process)</option>
              <option value="sse">SSE (Server-Sent Events)</option>
              <option value="http">HTTP</option>
            </select>
          </div>

          {formData.sourceType === 'stdio' && (
            <>
              <div>
                <label class="block text-sm font-medium text-fg-soft mb-1">
                  Command <span class="text-danger">*</span>
                </label>
                <input
                  type="text"
                  value={formData.command}
                  onChange={(e) =>
                    setFormData({ ...formData, command: (e.target as HTMLInputElement).value })
                  }
                  class={cn(
                    'w-full bg-surface-raised border rounded-lg px-3 py-2 text-sm text-fg-soft font-mono',
                    'focus:outline-none focus:ring-1 focus:ring-accent',
                    formErrors.command ? 'border-danger' : 'border-line'
                  )}
                  placeholder="e.g., npx"
                />
                {formErrors.command && <p class="text-xs text-danger mt-1">{formErrors.command}</p>}
              </div>

              <div>
                <label class="block text-sm font-medium text-fg-soft mb-1">Args</label>
                <input
                  type="text"
                  value={formData.args}
                  onChange={(e) =>
                    setFormData({ ...formData, args: (e.target as HTMLInputElement).value })
                  }
                  class={cn(
                    'w-full bg-surface-raised border rounded-lg px-3 py-2 text-sm text-fg-soft font-mono',
                    'focus:outline-none focus:ring-1 focus:ring-accent',
                    formErrors.args ? 'border-danger' : 'border-line'
                  )}
                  placeholder="e.g., -y @tokenizin/mcp-npx-fetch"
                />
                {formErrors.args && <p class="text-xs text-danger mt-1">{formErrors.args}</p>}
                <p class="text-xs text-fg-faint mt-1">Space-separated arguments</p>
              </div>
            </>
          )}

          {formData.sourceType !== 'stdio' && (
            <>
              <div>
                <label class="block text-sm font-medium text-fg-soft mb-1">
                  URL <span class="text-danger">*</span>
                </label>
                <input
                  type="text"
                  value={formData.url}
                  onChange={(e) =>
                    setFormData({ ...formData, url: (e.target as HTMLInputElement).value })
                  }
                  class={cn(
                    'w-full bg-surface-raised border rounded-lg px-3 py-2 text-sm text-fg-soft',
                    'focus:outline-none focus:ring-1 focus:ring-accent',
                    formErrors.url ? 'border-danger' : 'border-line'
                  )}
                  placeholder="e.g., http://localhost:8080/sse"
                />
                {formErrors.url && <p class="text-xs text-danger mt-1">{formErrors.url}</p>}
              </div>

              <div>
                <label class="block text-sm font-medium text-fg-soft mb-1">Headers</label>
                <textarea
                  value={formData.headers}
                  onChange={(e) =>
                    setFormData({ ...formData, headers: (e.target as HTMLTextAreaElement).value })
                  }
                  class={cn(
                    'w-full bg-surface-raised border rounded-lg px-3 py-2 text-sm text-fg-soft font-mono',
                    'focus:outline-none focus:ring-1 focus:ring-accent resize-none',
                    formErrors.headers ? 'border-danger' : 'border-line'
                  )}
                  rows={3}
                  placeholder="e.g., Authorization=Bearer token"
                />
                {formErrors.headers && <p class="text-xs text-danger mt-1">{formErrors.headers}</p>}
                <p class="text-xs text-fg-faint mt-1">One header per line in key=value format</p>
              </div>
            </>
          )}

          <div>
            <label class="block text-sm font-medium text-fg-soft mb-1">Environment Variables</label>
            <textarea
              value={formData.envVars}
              onChange={(e) =>
                setFormData({ ...formData, envVars: (e.target as HTMLTextAreaElement).value })
              }
              class={cn(
                'w-full bg-surface-raised border rounded-lg px-3 py-2 text-sm text-fg-soft font-mono',
                'focus:outline-none focus:ring-1 focus:ring-accent resize-none',
                formErrors.envVars ? 'border-danger' : 'border-line'
              )}
              rows={3}
              placeholder="e.g., MY_API_KEY=MY_API_KEY"
            />
            {formErrors.envVars && <p class="text-xs text-danger mt-1">{formErrors.envVars}</p>}
            <p class="text-xs text-fg-faint mt-1">
              One env var per line in key=value format. For secrets, set the value in your system
              environment and reference the env var name here.
            </p>
          </div>

          <div class="flex items-center justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" size="sm" onClick={closeForm}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={isSubmitting}>
              {editingServer ? 'Save Changes' : 'Add Server'}
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        isOpen={showDeleteConfirm}
        onClose={() => {
          setShowDeleteConfirm(false);
          setDeletingServer(null);
        }}
        onConfirm={handleDelete}
        title="Delete MCP Server"
        message={`Are you sure you want to delete "${deletingServer?.name}"? This action cannot be undone.`}
        confirmText="Delete"
        confirmButtonVariant="danger"
        isLoading={isSubmitting}
      />
    </>
  );
}
