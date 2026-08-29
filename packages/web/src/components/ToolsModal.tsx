import { useSignal, useComputed } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { Modal } from './ui/Modal.tsx';
import type {
  Session,
  ToolsConfig,
  GlobalToolsConfig,
  AppSkill,
  SessionMcpListResponse,
  SessionMcpServerEntry,
  McpEnablementSetOverrideResponse,
  McpEnablementClearOverrideResponse,
} from '@hyperneo/shared';
import { listRuntimeMcpServers } from '../lib/api-helpers.ts';
import { skillsStore } from '../lib/skills-store.ts';
import { globalSettings } from '../lib/state.ts';

const RUNTIME_MCP_LABELS: Record<string, { title: string; description: string }> = {
  'space-agent-tools': {
    title: 'Space coordination',
    description: 'send_message_to_agent, list_peers, gate I/O, task management',
  },
  'db-query': {
    title: 'Database queries',
    description: 'Read-only SQLite access scoped to this space',
  },
  'task-agent': {
    title: 'Task agent',
    description: 'Workflow execution, node activation, sub-agent spawning',
  },
  'node-agent': {
    title: 'Node agent',
    description: 'Workflow node tools: peers, channels, gates',
  },
  'room-tools': {
    title: 'Room tools',
    description: 'Room-scoped coordination between co-located agents',
  },
};
import {
  buildDisabledSkillsList,
  computeMcpSkillRuntimeState,
  computeSkillGroupState,
  getMcpServerEffectiveEnabled,
  getMcpServerProvenanceBadge,
  getMcpSkillRuntimeClasses,
  getSkillSourceBadge,
  isSkillEnabledForSession,
  type PendingMcpOverride,
} from './ToolsModal.utils.ts';

interface ToolsModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session | null;
}

interface GroupHeaderProps {
  title: string;
  isOpen: boolean;
  onToggleOpen: () => void;
  allEnabled: boolean;
  someEnabled: boolean;
  onToggleAll: () => void;
  itemCount: number;
  disabled?: boolean;
  scopeNote?: string;
}

function GroupHeader({
  title,
  isOpen,
  onToggleOpen,
  allEnabled,
  someEnabled,
  onToggleAll,
  itemCount,
  disabled = false,
  scopeNote,
}: GroupHeaderProps) {
  const isIndeterminate = someEnabled && !allEnabled;

  return (
    <div class="flex items-center justify-between py-2 cursor-pointer select-none group">
      <button
        type="button"
        class="flex items-center gap-2 flex-1 text-left hover:text-fg-soft transition-colors"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
      >
        <svg
          class={`w-3.5 h-3.5 text-fg-faint transition-transform ${isOpen ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M9 5l7 7-7 7" />
        </svg>
        <span class="text-sm font-medium text-fg-soft">{title}</span>
        <span class="text-xs text-fg-faint">({itemCount})</span>
      </button>
      <div class="flex items-center gap-3">
        {scopeNote && <span class="text-xs text-sky-500/70 font-medium">{scopeNote}</span>}
        <label
          class="flex items-center gap-1.5 cursor-pointer"
          title={allEnabled ? 'Disable all' : 'Enable all'}
        >
          <span class="text-xs text-fg-faint">
            {allEnabled ? 'All on' : someEnabled ? 'Mixed' : 'All off'}
          </span>
          <input
            type="checkbox"
            checked={allEnabled}
            ref={(el) => {
              if (el) el.indeterminate = isIndeterminate;
            }}
            onChange={onToggleAll}
            disabled={disabled}
            class="w-4 h-4 rounded border-line-strong text-accent focus:ring-accent focus:ring-offset-dark-900"
          />
        </label>
      </div>
    </div>
  );
}

function SourceBadge({ label, className }: { label: string; className: string }) {
  return <span class={`text-[10px] px-1.5 py-0.5 rounded font-medium ${className}`}>{label}</span>;
}

export function ToolsModal({ isOpen, onClose, session }: ToolsModalProps) {
  const saving = useSignal(false);
  const globalConfig = useSignal<GlobalToolsConfig | null>(null);

  const runtimeMcpGroupOpen = useSignal(true);
  const skillsGroupOpen = useSignal(true);
  const mcpServersGroupOpen = useSignal(true);
  const advancedOpen = useSignal(false);

  const runtimeMcpServers = useSignal<string[]>([]);

  const sessionMcpEntries = useSignal<SessionMcpServerEntry[]>([]);
  const mcpServerSearch = useSignal('');
  const sessionMcpLoaded = useSignal(false);

  const skillSearch = useSignal('');

  const pendingMcpOverrides = useSignal<Map<string, PendingMcpOverride>>(new Map());

  const pendingDisabledSkills = useSignal<Set<string>>(new Set());

  const useClaudeCodePreset = useSignal(true);
  const settingSources = useSignal<import('@hyperneo/shared').SettingSource[]>([
    'user',
    'project',
    'local',
  ]);
  const initialSettingSources = useSignal<import('@hyperneo/shared').SettingSource[]>([
    'user',
    'project',
    'local',
  ]);

  const initialDisabledSkills = useSignal<Set<string>>(new Set());
  const initialClaudeCodePreset = useSignal(true);
  const hasChanges = useComputed(() => {
    if (pendingMcpOverrides.value.size > 0) return true;
    const a = pendingDisabledSkills.value;
    const b = initialDisabledSkills.value;
    if (a.size !== b.size) return true;
    for (const id of a) {
      if (!b.has(id)) return true;
    }
    if (useClaudeCodePreset.value !== initialClaudeCodePreset.value) return true;
    if (JSON.stringify(settingSources.value) !== JSON.stringify(initialSettingSources.value))
      return true;
    return false;
  });

  useEffect(() => {
    if (isOpen && session) {
      loadConfig();
      void loadGlobalConfig();
      void loadRuntimeMcpServers();
      void loadSessionMcpEntries();
      void skillsStore.subscribe().catch(() => {
        toast.error('Failed to load App MCP Servers');
      });
    }
    return () => {
      skillsStore.unsubscribe();
    };
  }, [isOpen, session?.id]);

  const loadConfig = () => {
    if (!session) return;
    const tools = session.config.tools;
    useClaudeCodePreset.value = tools?.useClaudeCodePreset ?? true;
    initialClaudeCodePreset.value = useClaudeCodePreset.value;

    const disabled = new Set<string>(tools?.disabledSkills ?? []);
    pendingDisabledSkills.value = disabled;
    initialDisabledSkills.value = new Set(disabled);

    const sources = session.config.settingSources ??
      globalSettings.value?.settingSources ?? ['user', 'project', 'local'];
    settingSources.value = sources;
    initialSettingSources.value = [...sources];

    pendingMcpOverrides.value = new Map();
  };

  const loadGlobalConfig = async () => {
    try {
      const hub = await connectionManager.getHub();
      const response = await hub.request<{ config: GlobalToolsConfig }>('globalTools.getConfig');
      globalConfig.value = response.config;
    } catch {}
  };

  const loadRuntimeMcpServers = async () => {
    if (!session) return;
    try {
      const response = await listRuntimeMcpServers(session.id);
      runtimeMcpServers.value = response.servers.map((s) => s.name);
    } catch {
      runtimeMcpServers.value = [];
    }
  };

  const loadSessionMcpEntries = async () => {
    if (!session) {
      sessionMcpEntries.value = [];
      sessionMcpLoaded.value = false;
      return;
    }
    try {
      const hub = await connectionManager.getHub();
      const response = await hub.request<SessionMcpListResponse>('session.mcp.list', {
        sessionId: session.id,
      });
      sessionMcpEntries.value = response.entries ?? [];
      sessionMcpLoaded.value = true;
    } catch {
      sessionMcpEntries.value = [];
      sessionMcpLoaded.value = false;
    }
  };

  const isClaudeCodePresetAllowed = useComputed(
    () => globalConfig.value?.systemPrompt?.claudeCodePreset?.allowed ?? true
  );

  const allSkills = useComputed(() =>
    [...skillsStore.skills.value].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    )
  );

  const filteredSkills = useComputed(() => {
    const q = skillSearch.value.trim().toLowerCase();
    if (!q) return allSkills.value;
    return allSkills.value.filter(
      (s) =>
        s.displayName.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false)
    );
  });

  const filteredMcpEntries = useComputed(() => {
    const q = mcpServerSearch.value.trim().toLowerCase();
    if (!q) return sessionMcpEntries.value;
    return sessionMcpEntries.value.filter(
      (e) =>
        e.server.name.toLowerCase().includes(q) ||
        (e.server.description?.toLowerCase().includes(q) ?? false)
    );
  });

  const skillsGroupState = useComputed(() => {
    const items = allSkills.value
      .filter((s) => s.enabled)
      .map((s) => ({
        enabled: isSkillEnabledForSession(s, pendingDisabledSkills.value),
      }));
    return computeSkillGroupState(items);
  });
  const mcpGroupState = useComputed(() => {
    const items = sessionMcpEntries.value.map((entry) => ({
      enabled: getMcpServerEffectiveEnabled(entry, pendingMcpOverrides.value.get(entry.server.id)),
    }));
    return computeSkillGroupState(items);
  });

  const toggleSkill = (skill: AppSkill) => {
    if (!skill.enabled) return;
    const next = new Set(pendingDisabledSkills.value);
    if (next.has(skill.id)) {
      next.delete(skill.id);
    } else {
      next.add(skill.id);
    }
    pendingDisabledSkills.value = next;
  };

  const toggleAllSkills = () => {
    const togglable = allSkills.value.filter((s) => s.enabled);
    if (togglable.length === 0) return;
    const allOn = togglable.every((s) => isSkillEnabledForSession(s, pendingDisabledSkills.value));
    const next = new Set(pendingDisabledSkills.value);
    if (allOn) {
      for (const s of togglable) next.add(s.id);
    } else {
      for (const s of togglable) next.delete(s.id);
    }
    pendingDisabledSkills.value = next;
  };

  const toggleMcpServer = (entry: SessionMcpServerEntry) => {
    const current = pendingMcpOverrides.value.get(entry.server.id);
    const effective = getMcpServerEffectiveEnabled(entry, current);
    const next = new Map(pendingMcpOverrides.value);
    next.set(entry.server.id, { enabled: !effective });
    pendingMcpOverrides.value = next;
  };

  const clearMcpOverride = (entry: SessionMcpServerEntry) => {
    if (entry.source !== 'session') return;
    const next = new Map(pendingMcpOverrides.value);
    next.set(entry.server.id, { enabled: null });
    pendingMcpOverrides.value = next;
  };

  const toggleAllMcpServers = () => {
    if (sessionMcpEntries.value.length === 0) return;
    const allOn = sessionMcpEntries.value.every((entry) =>
      getMcpServerEffectiveEnabled(entry, pendingMcpOverrides.value.get(entry.server.id))
    );
    const next = new Map(pendingMcpOverrides.value);
    for (const entry of sessionMcpEntries.value) {
      next.set(entry.server.id, { enabled: !allOn });
    }
    pendingMcpOverrides.value = next;
  };

  const applyMcpOverrides = async (): Promise<{ ok: number; failed: string[] }> => {
    if (!session) return { ok: 0, failed: [] };
    const hub = await connectionManager.getHub();
    const sessionId = session.id;

    const ops: Array<{ entry: SessionMcpServerEntry; pending: PendingMcpOverride }> = [];
    for (const entry of sessionMcpEntries.value) {
      const pending = pendingMcpOverrides.value.get(entry.server.id);
      if (!pending) continue;
      if (pending.enabled === null && entry.source !== 'session') continue;
      if (
        pending.enabled !== null &&
        pending.enabled === entry.enabled &&
        entry.source === 'session'
      ) {
        continue;
      }
      ops.push({ entry, pending });
    }

    const results = await Promise.allSettled(
      ops.map(({ entry, pending }) => {
        if (pending.enabled === null) {
          return hub.request<McpEnablementClearOverrideResponse>('mcp.enablement.clearOverride', {
            scopeType: 'session',
            scopeId: sessionId,
            serverId: entry.server.id,
          });
        }
        return hub.request<McpEnablementSetOverrideResponse>('mcp.enablement.setOverride', {
          scopeType: 'session',
          scopeId: sessionId,
          serverId: entry.server.id,
          enabled: pending.enabled,
        });
      })
    );

    const failed: string[] = [];
    let ok = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') ok++;
      else failed.push(ops[i].entry.server.name);
    });
    return { ok, failed };
  };

  const handleSave = async () => {
    if (!session || !hasChanges.value) return;
    try {
      saving.value = true;

      const mcp = await applyMcpOverrides();
      if (mcp.failed.length > 0) {
        toast.error(
          `Failed to update ${mcp.failed.length} MCP server(s): ${mcp.failed.join(', ')}`
        );
      }

      const toolsConfig: ToolsConfig = {
        ...session.config.tools,
        useClaudeCodePreset: useClaudeCodePreset.value,
        disabledSkills: buildDisabledSkillsList(allSkills.value, pendingDisabledSkills.value),
      };
      const hub = await connectionManager.getHub();
      const result = await hub.request<{ success: boolean; error?: string }>('tools.save', {
        sessionId: session.id,
        tools: toolsConfig,
      });
      if (!result.success) {
        toast.error(result.error || 'Failed to save tools configuration');
        return;
      }

      if (JSON.stringify(settingSources.value) !== JSON.stringify(initialSettingSources.value)) {
        await hub.request('session.update', {
          sessionId: session.id,
          config: { settingSources: settingSources.value },
        });
      }

      await loadSessionMcpEntries();
      toast.success('Tools configuration saved');
      onClose();
    } catch {
      toast.error('Failed to save tools configuration');
    } finally {
      saving.value = false;
    }
  };

  const handleCancel = () => {
    loadConfig();
    onClose();
  };

  if (!session) return null;

  const skillsState = skillsGroupState.value;
  const mcpState = mcpGroupState.value;
  const skillsRows = filteredSkills.value;
  const mcpRows = filteredMcpEntries.value;
  const togglableSkillCount = allSkills.value.filter((s) => s.enabled).length;

  return (
    <Modal isOpen={isOpen} onClose={handleCancel} title="Tools" size="md">
      <div class="space-y-4">
        {runtimeMcpServers.value.length > 0 && (
          <>
            <div>
              <div class="flex items-center justify-between py-2 select-none group">
                <button
                  type="button"
                  class="flex items-center gap-2 flex-1 text-left hover:text-fg-soft transition-colors"
                  onClick={() => {
                    runtimeMcpGroupOpen.value = !runtimeMcpGroupOpen.value;
                  }}
                  aria-expanded={runtimeMcpGroupOpen.value}
                >
                  <svg
                    class={`w-3.5 h-3.5 text-fg-faint transition-transform ${runtimeMcpGroupOpen.value ? 'rotate-90' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                  <span class="text-sm font-medium text-fg-soft">Agent Runtime Tools</span>
                  <span class="text-xs text-fg-faint">({runtimeMcpServers.value.length})</span>
                </button>
                <span class="text-xs text-emerald-500/70 font-medium">Built-in</span>
              </div>
              {runtimeMcpGroupOpen.value && (
                <div class="mt-1 ml-5 space-y-1">
                  {runtimeMcpServers.value.map((name) => {
                    const label = RUNTIME_MCP_LABELS[name];
                    return (
                      <div
                        key={`runtime-${name}`}
                        class="flex items-center gap-2 p-2 rounded-lg bg-surface-raised/50 min-w-0"
                      >
                        <svg
                          class="w-3.5 h-3.5 text-success flex-shrink-0"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width={2}
                            d="M13 10V3L4 14h7v7l9-11h-7z"
                          />
                        </svg>
                        <div class="flex-1 min-w-0">
                          <div class="text-sm text-fg-soft truncate">{label?.title ?? name}</div>
                          <div class="text-xs text-fg-faint truncate">
                            {label?.description ?? name}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div class="border-t border-line-strong" />
          </>
        )}

        <div>
          {allSkills.value.length > 0 ? (
            <>
              <GroupHeader
                title="Skills"
                isOpen={skillsGroupOpen.value}
                onToggleOpen={() => {
                  skillsGroupOpen.value = !skillsGroupOpen.value;
                }}
                allEnabled={skillsState.allEnabled}
                someEnabled={skillsState.someEnabled}
                onToggleAll={toggleAllSkills}
                itemCount={allSkills.value.length}
                disabled={togglableSkillCount === 0}
                scopeNote="This session"
              />
              {skillsGroupOpen.value && (
                <div class="mt-2 ml-5 space-y-2">
                  <div class="text-xs text-fg-faint">
                    Toggles apply to this session only. Click Save to persist.
                  </div>
                  {allSkills.value.length > 4 && (
                    <input
                      type="search"
                      placeholder="Filter skills…"
                      value={skillSearch.value}
                      onInput={(e) => {
                        skillSearch.value = (e.target as HTMLInputElement).value;
                      }}
                      class="w-full text-xs bg-surface border border-line rounded px-2.5 py-1.5 text-fg-soft placeholder-gray-600 focus:outline-none focus:border-accent/50"
                    />
                  )}
                  {skillsRows.length === 0 ? (
                    <div class="text-xs text-fg-faint py-1">
                      No skills match &ldquo;{skillSearch.value}&rdquo;.
                    </div>
                  ) : (
                    <div class="grid grid-cols-2 gap-1">
                      {skillsRows.map((skill) => {
                        const sessionEnabled = isSkillEnabledForSession(
                          skill,
                          pendingDisabledSkills.value
                        );
                        const runtime = computeMcpSkillRuntimeState(
                          skill,
                          sessionMcpEntries.value,
                          sessionMcpLoaded.value
                        );
                        const { dot: runtimeDotClass, text: runtimeTextClass } =
                          getMcpSkillRuntimeClasses(runtime.status);
                        const sourceBadge = getSkillSourceBadge(skill);
                        const globallyDisabled = !skill.enabled;
                        return (
                          <label
                            key={skill.id}
                            class={`flex items-center gap-2 p-2 rounded-lg bg-surface-raised/50 transition-colors min-w-0 ${
                              globallyDisabled
                                ? 'opacity-50 cursor-not-allowed'
                                : 'hover:bg-surface-raised cursor-pointer'
                            }`}
                            title={
                              globallyDisabled
                                ? 'This skill is disabled at the global level. Enable it in Settings to toggle here.'
                                : undefined
                            }
                          >
                            <div class="flex-1 min-w-0">
                              <div class="flex items-center gap-1.5">
                                <span class="text-xs text-fg-soft truncate">
                                  {skill.displayName}
                                </span>
                                <SourceBadge {...sourceBadge} />
                              </div>
                              {runtime.status !== 'unknown' && runtime.label && (
                                <div
                                  class={`text-[10px] truncate flex items-center gap-1 mt-0.5 ${runtimeTextClass}`}
                                  title={runtime.label}
                                  data-testid={`skill-runtime-${skill.name}`}
                                  data-status={runtime.status}
                                >
                                  <span
                                    class={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${runtimeDotClass}`}
                                  />
                                  <span class="truncate">{runtime.label}</span>
                                </div>
                              )}
                            </div>
                            <div class="flex items-center gap-1 flex-shrink-0">
                              <input
                                type="checkbox"
                                checked={sessionEnabled}
                                onChange={() => toggleSkill(skill)}
                                disabled={globallyDisabled}
                                class="w-3.5 h-3.5 rounded border-line-strong text-accent focus:ring-accent focus:ring-offset-dark-900"
                              />
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div class="flex items-center gap-2 py-1">
              <svg
                class="w-3.5 h-3.5 text-fg-faint"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
              <span class="text-sm font-medium text-fg-faint">Skills</span>
              <span class="text-xs text-gray-700">(none configured)</span>
            </div>
          )}
        </div>

        <div class="border-t border-line-strong" />

        <div>
          {sessionMcpEntries.value.length > 0 ? (
            <>
              <GroupHeader
                title="MCP Servers"
                isOpen={mcpServersGroupOpen.value}
                onToggleOpen={() => {
                  mcpServersGroupOpen.value = !mcpServersGroupOpen.value;
                }}
                allEnabled={mcpState.allEnabled}
                someEnabled={mcpState.someEnabled}
                onToggleAll={toggleAllMcpServers}
                itemCount={sessionMcpEntries.value.length}
                scopeNote="This session"
              />
              {mcpServersGroupOpen.value && (
                <div class="mt-2 ml-5 space-y-2">
                  <div class="text-xs text-fg-faint">
                    Overrides apply to this session only. Click Save to persist; changes take effect
                    on the next respawn.
                  </div>
                  {sessionMcpEntries.value.length > 4 && (
                    <input
                      type="search"
                      placeholder="Filter MCP servers…"
                      value={mcpServerSearch.value}
                      onInput={(e) => {
                        mcpServerSearch.value = (e.target as HTMLInputElement).value;
                      }}
                      class="w-full text-xs bg-surface border border-line rounded px-2.5 py-1.5 text-fg-soft placeholder-gray-600 focus:outline-none focus:border-accent/50"
                    />
                  )}
                  {mcpRows.length === 0 ? (
                    <div class="text-xs text-fg-faint py-1">
                      No servers match &ldquo;{mcpServerSearch.value}&rdquo;.
                    </div>
                  ) : (
                    <div class="space-y-1">
                      {mcpRows.map((entry) => {
                        const pending = pendingMcpOverrides.value.get(entry.server.id);
                        const effectiveEnabled = getMcpServerEffectiveEnabled(entry, pending);
                        const provenanceBadge = getMcpServerProvenanceBadge(entry.server);
                        const showClearAffordance =
                          entry.source === 'session' && (!pending || pending.enabled !== null);
                        return (
                          <div
                            key={`mcp-${entry.server.id}`}
                            class="flex items-center gap-2 p-2 rounded-lg bg-surface-raised/50 min-w-0"
                          >
                            <svg
                              class="w-3.5 h-3.5 text-warning flex-shrink-0"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width={2}
                                d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2"
                              />
                            </svg>
                            <div class="flex-1 min-w-0">
                              <div class="flex items-center gap-1.5">
                                <span class="text-xs text-fg-soft truncate">
                                  {entry.server.name}
                                </span>
                                <SourceBadge {...provenanceBadge} />
                              </div>
                              {entry.server.description && (
                                <div class="text-[10px] text-fg-faint truncate">
                                  {entry.server.description}
                                </div>
                              )}
                            </div>
                            <div class="flex items-center gap-2 flex-shrink-0">
                              {showClearAffordance && (
                                <button
                                  type="button"
                                  class="text-[10px] text-fg-faint hover:text-fg-soft transition-colors"
                                  title="Revert this session back to the inherited value"
                                  onClick={() => clearMcpOverride(entry)}
                                >
                                  Clear
                                </button>
                              )}
                              <input
                                type="checkbox"
                                checked={effectiveEnabled}
                                onChange={() => toggleMcpServer(entry)}
                                class="w-3.5 h-3.5 rounded border-line-strong text-accent focus:ring-accent focus:ring-offset-dark-900"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div class="flex items-center gap-2 py-1">
              <svg
                class="w-3.5 h-3.5 text-fg-faint"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
              <span class="text-sm font-medium text-fg-faint">MCP Servers</span>
              <span class="text-xs text-gray-700">(none configured)</span>
            </div>
          )}
        </div>

        <div class="border-t border-line-strong" />

        <div>
          <button
            type="button"
            class="flex items-center gap-2 w-full text-left py-1 hover:text-fg-soft transition-colors"
            onClick={() => {
              advancedOpen.value = !advancedOpen.value;
            }}
            aria-expanded={advancedOpen.value}
          >
            <svg
              class={`w-3.5 h-3.5 text-fg-faint transition-transform ${advancedOpen.value ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
            <span class="text-sm font-medium text-fg-faint">Advanced</span>
          </button>

          {advancedOpen.value && (
            <div class="mt-3 space-y-4 ml-5">
              <div>
                <h4 class="text-xs font-medium text-fg-faint uppercase tracking-wider mb-2">
                  System Prompt
                </h4>
                <label
                  class={`flex items-center justify-between p-2 rounded-lg bg-surface-raised/50 transition-colors ${isClaudeCodePresetAllowed.value ? 'hover:bg-surface-raised cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
                >
                  <div>
                    <div class="text-sm text-fg-soft">Claude Code Preset</div>
                    <div class="text-xs text-fg-faint">Use official Claude Code system prompt</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={useClaudeCodePreset.value}
                    onChange={() => {
                      useClaudeCodePreset.value = !useClaudeCodePreset.value;
                    }}
                    disabled={!isClaudeCodePresetAllowed.value}
                    class="w-4 h-4 rounded border-line-strong text-accent"
                  />
                </label>
              </div>
              <div>
                <h4 class="text-xs font-medium text-fg-faint uppercase tracking-wider mb-2">
                  Setting Sources
                </h4>
                <div class="space-y-1.5">
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settingSources.value.includes('user')}
                      onChange={() =>
                        (settingSources.value = settingSources.value.includes('user')
                          ? settingSources.value.filter((s) => s !== 'user')
                          : [...settingSources.value, 'user'])
                      }
                      class="w-4 h-4 rounded border-line-strong text-accent focus:ring-accent focus:ring-offset-dark-900"
                    />
                    <span class="text-sm text-fg-soft">User settings</span>
                    <span class="text-xs text-fg-faint">(~/.claude/settings.json)</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settingSources.value.includes('project')}
                      onChange={() =>
                        (settingSources.value = settingSources.value.includes('project')
                          ? settingSources.value.filter((s) => s !== 'project')
                          : [...settingSources.value, 'project'])
                      }
                      class="w-4 h-4 rounded border-line-strong text-accent focus:ring-accent focus:ring-offset-dark-900"
                    />
                    <span class="text-sm text-fg-soft">Project settings + CLAUDE.md</span>
                    <span class="text-xs text-fg-faint">(.claude/settings.json)</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settingSources.value.includes('local')}
                      onChange={() =>
                        (settingSources.value = settingSources.value.includes('local')
                          ? settingSources.value.filter((s) => s !== 'local')
                          : [...settingSources.value, 'local'])
                      }
                      class="w-4 h-4 rounded border-line-strong text-accent focus:ring-accent focus:ring-offset-dark-900"
                    />
                    <span class="text-sm text-fg-soft">Local settings</span>
                    <span class="text-xs text-fg-faint">(.claude/settings.local.json)</span>
                  </label>
                </div>
              </div>
            </div>
          )}
        </div>

        <div class="pt-4 border-t border-line-strong flex gap-3 justify-end">
          <button
            type="button"
            onClick={handleCancel}
            class="px-4 py-2 text-sm font-medium text-fg-soft hover:text-fg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!hasChanges.value || saving.value}
            class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              hasChanges.value && !saving.value
                ? 'bg-accent text-accent-fg hover:bg-accent-hover'
                : 'bg-fill-strong text-fg-faint cursor-not-allowed'
            }`}
          >
            {saving.value ? (
              <span class="flex items-center gap-2">
                <div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Saving...
              </span>
            ) : (
              'Save'
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
