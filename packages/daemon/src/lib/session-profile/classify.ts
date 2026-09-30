export type SessionKind =
  | 'chat.default'
  | 'space.chat'
  | 'space.agent'
  | 'space.member'
  | 'space.task.postApproval'
  | 'space.task.worker'
  | 'space.task.legacy';

export type SessionCapability =
  | 'holds.goals'
  | 'holds.schedules'
  | 'mcp.node-agent'
  | 'mcp.space-actions'
  | 'mcp.space-agent-tools'
  | 'responsibilities.escalation'
  | 'surface.console'
  | 'surface.longHorizonAgent'
  | 'surface.member'
  | 'surface.workflowNode';

export type KindCapability = Exclude<
  SessionCapability,
  'holds.goals' | 'holds.schedules' | 'responsibilities.escalation'
>;

export type DeclaredCapability = Extract<
  SessionCapability,
  'holds.goals' | 'holds.schedules' | 'responsibilities.escalation'
>;

export interface SessionFacts {
  readonly sessionId: string;
  readonly sessionType: string;
  readonly spaceId?: string;
  readonly taskId?: string;
  readonly taskSpaceId?: string;
  readonly agentId?: string;
  readonly isCanonicalAgentSession?: boolean;
  readonly isWorkflowWorker?: boolean;
  readonly declaredCapabilities?: readonly DeclaredCapability[];
}

export interface SessionProfile {
  readonly kind: SessionKind;
  readonly sessionId: string;
  readonly spaceId?: string;
  readonly taskId?: string;
  readonly agentId?: string;
  readonly capabilities: readonly SessionCapability[];
}

const SPACE_AGENT_TOOLS_SERVER = 'space-agent-tools';
const NODE_AGENT_SERVER = 'node-agent';
const SPACE_ACTIONS_SERVER = 'space-actions';

const POST_APPROVAL_MARKER = ':post-approval:';

const CAPABILITIES_BY_KIND: Record<SessionKind, readonly SessionCapability[]> = {
  'chat.default': ['mcp.space-actions'],
  'space.chat': ['mcp.space-agent-tools', 'surface.console'],
  'space.agent': ['mcp.space-agent-tools', 'surface.longHorizonAgent'],
  'space.member': ['mcp.space-agent-tools', 'surface.member'],
  'space.task.postApproval': ['mcp.space-agent-tools', 'surface.member'],
  'space.task.worker': ['mcp.node-agent', 'surface.workflowNode'],
  'space.task.legacy': [],
};

const MCP_SERVER_BY_CAPABILITY: Partial<Record<SessionCapability, string>> = {
  'mcp.node-agent': NODE_AGENT_SERVER,
  'mcp.space-actions': SPACE_ACTIONS_SERVER,
  'mcp.space-agent-tools': SPACE_AGENT_TOOLS_SERVER,
};

export function hasCapability(profile: SessionProfile, capability: SessionCapability): boolean {
  return profile.capabilities.includes(capability);
}

export function requiredMcpServersFor(kind: SessionKind): string[] {
  const servers: string[] = [];
  for (const capability of CAPABILITIES_BY_KIND[kind]) {
    const server = MCP_SERVER_BY_CAPABILITY[capability];
    if (server && !servers.includes(server)) servers.push(server);
  }
  return servers;
}

export function classifySession(facts: SessionFacts): SessionProfile {
  const kind = decideKind(facts);
  const spaceId = facts.spaceId ?? (kind === 'space.task.worker' ? facts.taskSpaceId : undefined);
  return {
    kind,
    sessionId: facts.sessionId,
    spaceId,
    taskId: facts.taskId,
    agentId: kind === 'space.agent' ? facts.agentId : undefined,
    capabilities: mergeCapabilities(CAPABILITIES_BY_KIND[kind], facts.declaredCapabilities),
  };
}

function mergeCapabilities(
  kindCapabilities: readonly SessionCapability[],
  declared: readonly DeclaredCapability[] | undefined
): readonly SessionCapability[] {
  if (!declared || declared.length === 0) return kindCapabilities;
  return [...new Set<SessionCapability>([...kindCapabilities, ...declared])];
}

function decideKind(facts: SessionFacts): SessionKind {
  if (facts.sessionType === 'space_task_agent') return 'space.task.legacy';
  if (facts.sessionType === 'space_chat' && facts.spaceId) return 'space.chat';
  if (facts.isWorkflowWorker) return 'space.task.worker';
  if (!facts.spaceId) return 'chat.default';
  if (facts.isCanonicalAgentSession && facts.agentId) return 'space.agent';
  if (facts.sessionId.includes(POST_APPROVAL_MARKER)) return 'space.task.postApproval';
  return 'space.member';
}
