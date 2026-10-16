import type {
  AgentModelPoolEntry,
  HandoffTransition,
  NodeExecutionStatus,
  ThinkingLevel,
  WorkflowChannel,
  WorkflowNodeAgent,
  WorkflowNodeAgentOverride,
} from '@hyperneo/shared';

export interface NodeDraft {
  localId: string;
  id?: string;
  name: string;
  agentId: string;
  templateKey?: string | null;
  model?: string;
  provider?: string;
  modelPool?: AgentModelPoolEntry[];
  thinkingLevel?: ThinkingLevel;
  customPrompt?: WorkflowNodeAgentOverride;
  replaceAgentPrompt?: boolean;
  disabledSkillIds?: string[];
  resetContextPerTurn?: boolean;
  agents?: WorkflowNodeAgent[];
  channels?: WorkflowChannel[];
  postApproval?: import('@hyperneo/shared').PostApprovalRoute;
  requirePrMerge?: boolean;
  handoffTransitions?: HandoffTransition[];
}

export function isMultiAgentNode(node: NodeDraft): boolean {
  return Array.isArray(node.agents) && node.agents.length > 1;
}

export interface AgentTaskState {
  agentName: string | null;
  status: NodeExecutionStatus;
  completionSummary?: string | null;
}

function SpinnerIcon({ title }: { title?: string }) {
  return (
    <svg
      class="w-3 h-3 animate-spin"
      fill="none"
      viewBox="0 0 24 24"
      aria-label={title}
      data-testid="agent-status-spinner"
    >
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function CheckIcon({ title }: { title?: string }) {
  return (
    <svg
      class="w-3 h-3"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-label={title}
      data-testid="agent-status-check"
    >
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2.5} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function FailIcon({ title }: { title?: string }) {
  return (
    <svg
      class="w-3 h-3"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-label={title}
      data-testid="agent-status-fail"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={2.5}
        d="M6 18L18 6M6 6l12 12"
      />
    </svg>
  );
}

export function AgentStatusIcon({ state }: { state: AgentTaskState }) {
  const summary = state.completionSummary ?? undefined;
  if (state.status === 'idle') {
    return (
      <span class="text-success flex-shrink-0" title={summary ?? 'Done'}>
        <CheckIcon title={summary ?? 'Done'} />
      </span>
    );
  }
  if (state.status === 'in_progress') {
    return (
      <span class="text-accent flex-shrink-0" title="In progress">
        <SpinnerIcon title="In progress" />
      </span>
    );
  }
  if (state.status === 'blocked' || state.status === 'cancelled') {
    return (
      <span class="text-danger flex-shrink-0" title={summary ?? state.status}>
        <FailIcon title={summary ?? state.status} />
      </span>
    );
  }
  return (
    <span
      class="w-1.5 h-1.5 rounded-full bg-fg-faint flex-shrink-0"
      title={state.status}
      data-testid="agent-status-pending"
    />
  );
}

export function extractOverrideValue(
  override: WorkflowNodeAgentOverride | string | undefined
): string {
  if (!override) return '';
  if (typeof override === 'string') return override;
  return override.value ?? '';
}

export function buildOverride(value: string): WorkflowNodeAgentOverride | undefined {
  return value.trim() ? { value } : undefined;
}
