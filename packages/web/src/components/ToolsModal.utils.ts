import type { AppMcpServer, AppSkill, SessionMcpServerEntry } from '@hyperneo/shared';
import type { SessionToolInventory } from '@hyperneo/shared/types/observed-tool-inventory';
import superpipe, { type PipelineAPI } from 'superpipe';

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
  | 'pending'
  | 'instructions-loaded'
  | 'unknown';

export interface McpSkillRuntimeState {
  status: McpSkillRuntimeStatus;
  appMcpServerId?: string;
  overrideSource?: SessionMcpServerEntry['source'];
  label: string;
}

function projectObservedRuntime(
  inventory: SessionToolInventory | null,
  name: string
): McpSkillRuntimeState {
  const server = inventory?.mcpServers.find((entry) => entry.name === name);
  if (server?.status === 'connected') {
    return {
      status: server.tools?.length === 0 ? 'pending' : 'active',
      label:
        server.tools === null
          ? 'Attached · tool count unverified'
          : server.tools.length
            ? `Attached · ${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'}`
            : 'Connected · 0 tools',
    };
  }
  const reason = server
    ? {
        failed: 'connection failed',
        'needs-auth': 'sign-in or consent required',
        pending: 'connecting',
        disabled: 'server disabled in the running session',
        unverified: 'server status could not be verified',
        connected: '',
      }[server.status]
    : inventory
      ? {
          not_running: 'session not running',
          awaiting_init: 'session is starting',
          unverified: 'provider cannot confirm tools',
          observed: 'not observed; restart may be needed',
        }[inventory.state]
      : 'running inventory unavailable';
  return { status: 'pending', label: `Configured but not attached yet — ${reason}` };
}

export const computeObservedRuntimeState = (superpipe({})('observed-tool-row') as PipelineAPI)
  .input(['inventory', 'name'])
  .pipe(projectObservedRuntime, ['inventory', 'name'], 'state')
  .end('state') as (inventory: SessionToolInventory | null, name: string) => McpSkillRuntimeState;

export function computeMcpSkillRuntimeState(
  skill: AppSkill,
  sessionMcpList: SessionMcpServerEntry[],
  sessionMcpLoaded: boolean,
  inventory: SessionToolInventory | null = null,
  disabledSkills: ReadonlySet<string> = new Set()
): McpSkillRuntimeState {
  const observed = computeObservedRuntimeState(inventory, skill.name);
  if (inventory?.mcpServers.some((server) => server.name === skill.name)) return observed;
  if (skill.sourceType !== 'mcp_server' || skill.config.type !== 'mcp_server') {
    const name = skill.config.type === 'builtin' ? skill.config.commandName : skill.name;
    if (inventory?.skills.includes(name) || inventory?.plugins.includes(name)) {
      return {
        status: 'instructions-loaded',
        label: 'Instructions loaded · prerequisites unverified',
      };
    }
    return !skill.enabled || disabledSkills.has(skill.id)
      ? { status: 'skill-disabled', label: 'Off · skill disabled' }
      : observed;
  }

  const appMcpServerId = skill.config.appMcpServerId;

  if (!sessionMcpLoaded) {
    return { ...observed, appMcpServerId };
  }

  if (!skill.enabled || disabledSkills.has(skill.id)) {
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
      label: 'Off · skill disabled — not injected',
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
      entry.source === 'session' ? 'this session' : entry.source === 'space' ? 'space' : 'registry';
    return {
      status: 'server-off',
      appMcpServerId,
      overrideSource: entry.source,
      label: `MCP server disabled at ${where}`,
    };
  }

  return {
    ...observed,
    appMcpServerId,
  };
}

export interface McpSkillRuntimeClasses {
  dot: string;
  text: string;
}

export function getMcpSkillRuntimeClasses(status: McpSkillRuntimeStatus): McpSkillRuntimeClasses {
  switch (status) {
    case 'instructions-loaded':
    case 'active':
      return { dot: 'bg-emerald-400', text: 'text-emerald-500/70' };
    case 'server-off':
      return { dot: 'bg-warning', text: 'text-warning/70' };
    case 'server-missing':
      return { dot: 'bg-red-400', text: 'text-danger' };
    case 'skill-disabled':
    case 'pending':
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
