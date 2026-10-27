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
