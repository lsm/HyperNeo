import type {
  AppMcpServer,
  AppSkill,
  McpEffectiveEnablementSource,
  SessionMcpServerEntry,
} from '@hyperneo/shared';

export function computeSkillGroupState(items: { enabled: boolean }[]): {
  allEnabled: boolean;
  someEnabled: boolean;
  isIndeterminate: boolean;
} {
  if (items.length === 0) {
    return { allEnabled: false, someEnabled: false, isIndeterminate: false };
  }
  const allEnabled = items.every((s) => s.enabled);
  const someEnabled = items.some((s) => s.enabled);
  return { allEnabled, someEnabled, isIndeterminate: someEnabled && !allEnabled };
}

export type McpSkillRuntimeStatus =
  | 'active'
  | 'skill-disabled'
  | 'server-off'
  | 'server-missing'
  | 'unknown';

export interface McpSkillRuntimeState {
  status: McpSkillRuntimeStatus;
  appMcpServerId?: string;
  overrideSource?: SessionMcpServerEntry['source'];
  label: string;
}

export function computeMcpSkillRuntimeState(
  skill: AppSkill,
  sessionMcpList: SessionMcpServerEntry[],
  sessionMcpLoaded: boolean
): McpSkillRuntimeState {
  if (skill.sourceType !== 'mcp_server' || skill.config.type !== 'mcp_server') {
    return { status: 'unknown', label: '' };
  }

  const appMcpServerId = skill.config.appMcpServerId;

  if (!sessionMcpLoaded) {
    return { status: 'unknown', appMcpServerId, label: '' };
  }

  if (!skill.enabled) {
    const entry = sessionMcpList.find((e) => e.server.id === appMcpServerId);
    if (!entry) {
      return {
        status: 'server-missing',
        appMcpServerId,
        label: 'No backing MCP server',
      };
    }
    return {
      status: 'skill-disabled',
      appMcpServerId,
      label: 'Skill off — not injected',
    };
  }

  const entry = sessionMcpList.find((e) => e.server.id === appMcpServerId);
  if (!entry) {
    return {
      status: 'server-missing',
      appMcpServerId,
      label: 'No backing MCP server',
    };
  }

  if (!entry.enabled) {
    const where =
      entry.source === 'session'
        ? 'this session'
        : entry.source === 'room'
          ? 'room'
          : entry.source === 'space'
            ? 'space'
            : 'registry';
    return {
      status: 'server-off',
      appMcpServerId,
      overrideSource: entry.source,
      label: `MCP server disabled at ${where}`,
    };
  }

  return {
    status: 'active',
    appMcpServerId,
    label: 'Active in this session',
  };
}

export interface McpSkillRuntimeClasses {
  dot: string;
  text: string;
}

export function getMcpSkillRuntimeClasses(status: McpSkillRuntimeStatus): McpSkillRuntimeClasses {
  switch (status) {
    case 'active':
      return { dot: 'bg-emerald-400', text: 'text-emerald-500/70' };
    case 'server-off':
      return { dot: 'bg-warning', text: 'text-warning/70' };
    case 'server-missing':
      return { dot: 'bg-red-400', text: 'text-danger' };
    case 'skill-disabled':
    case 'unknown':
      return { dot: 'bg-fg-faint', text: 'text-fg-faint' };
  }
}

export function computeMcpServerSkillLinkage(skills: AppSkill[]): Map<string, AppSkill> {
  const map = new Map<string, AppSkill>();
  for (const skill of skills) {
    if (skill.sourceType !== 'mcp_server' || skill.config.type !== 'mcp_server') continue;
    const serverId = skill.config.appMcpServerId;
    if (!serverId) continue;
    if (!map.has(serverId)) {
      map.set(serverId, skill);
    }
  }
  return map;
}

export function isSkillEnabledForSession(
  skill: AppSkill,
  pendingDisabledSkills: ReadonlySet<string>
): boolean {
  if (!skill.enabled) return false;
  return !pendingDisabledSkills.has(skill.id);
}

export function buildDisabledSkillsList(
  skills: AppSkill[],
  pendingDisabledSkills: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  for (const skill of skills) {
    if (pendingDisabledSkills.has(skill.id)) out.push(skill.id);
  }
  return out;
}

export interface SourceBadgeStyle {
  label: string;
  className: string;
}

export function getSkillSourceBadge(skill: AppSkill): SourceBadgeStyle {
  switch (skill.sourceType) {
    case 'builtin':
      return { label: 'Built-in', className: 'text-accent/80 bg-accent-soft/10' };
    case 'plugin':
      return { label: 'Plugin', className: 'text-violet-400/80 bg-violet-400/10' };
    case 'mcp_server':
      return { label: 'MCP', className: 'text-warning/80 bg-warning/10' };
  }
}

const MCP_SOURCE_LABELS: Record<McpEffectiveEnablementSource, SourceBadgeStyle> = {
  session: { label: 'Session override', className: 'text-info/80 bg-sky-400/10' },
  room: { label: 'Inherited from room', className: 'text-cat-purple/80 bg-cat-purple/10' },
  space: { label: 'Inherited from space', className: 'text-fuchsia-400/80 bg-fuchsia-400/10' },
  registry: { label: 'Registry default', className: 'text-fg-muted/80 bg-fg-muted/10' },
};

export function getMcpServerSourceBadge(source: McpEffectiveEnablementSource): SourceBadgeStyle {
  return MCP_SOURCE_LABELS[source];
}

export function getMcpServerProvenanceBadge(server: AppMcpServer): SourceBadgeStyle {
  switch (server.source) {
    case 'builtin':
      return { label: 'Built-in', className: 'text-accent/80 bg-accent-soft/10' };
    case 'imported':
      return { label: 'Imported', className: 'text-success/80 bg-emerald-400/10' };
    case 'user':
      return { label: 'User', className: 'text-fg-soft/80 bg-fg-muted/10' };
  }
}

export type PendingMcpOverride = { enabled: boolean | null };

export function getMcpServerEffectiveEnabled(
  entry: SessionMcpServerEntry,
  pending: PendingMcpOverride | undefined
): boolean {
  if (pending && pending.enabled !== null) return pending.enabled;
  return entry.enabled;
}
