import type { AgentProcessingState } from '@hyperneo/shared';

export type SessionProcessingTone =
  | 'neutral'
  | 'info'
  | 'progress'
  | 'success'
  | 'warning'
  | 'danger'
  | 'special';

export interface SessionProcessingClasses {
  bg: string;
  text: string;
  border: string;
  soft: string;
  spinner: string;
}

const SESSION_PROCESSING_TONE_CLASSES: Record<SessionProcessingTone, SessionProcessingClasses> = {
  neutral: {
    bg: 'bg-fg-faint',
    text: 'text-fg-muted',
    border: 'border-fg-faint/30',
    soft: 'border-fg-faint/30 bg-fg-faint/10 text-fg-muted',
    spinner: 'border-fg-faint',
  },
  info: {
    bg: 'bg-accent',
    text: 'text-accent',
    border: 'border-accent/30',
    soft: 'border-accent/30 bg-accent/10 text-accent',
    spinner: 'border-accent',
  },
  progress: {
    bg: 'bg-warning',
    text: 'text-warning',
    border: 'border-warning/30',
    soft: 'border-warning/30 bg-warning/10 text-warning',
    spinner: 'border-warning',
  },
  success: {
    bg: 'bg-success',
    text: 'text-success',
    border: 'border-success/30',
    soft: 'border-success/30 bg-success/10 text-success',
    spinner: 'border-success',
  },
  warning: {
    bg: 'bg-warning',
    text: 'text-warning',
    border: 'border-warning/30',
    soft: 'border-warning/30 bg-warning/10 text-warning',
    spinner: 'border-warning',
  },
  danger: {
    bg: 'bg-danger',
    text: 'text-danger',
    border: 'border-danger/30',
    soft: 'border-danger/30 bg-danger/10 text-danger',
    spinner: 'border-danger',
  },
  special: {
    bg: 'bg-cat-purple',
    text: 'text-cat-purple',
    border: 'border-cat-purple/30',
    soft: 'border-cat-purple/30 bg-cat-purple/10 text-cat-purple',
    spinner: 'border-cat-purple',
  },
};

export interface SessionProcessingConfig {
  tone: SessionProcessingTone;
  label: string;
}

export const SESSION_PROCESSING_STATUS_CONFIG: Record<
  AgentProcessingState['status'],
  SessionProcessingConfig
> = {
  idle: { tone: 'neutral', label: 'Idle' },
  queued: { tone: 'progress', label: 'Queued' },
  processing: { tone: 'info', label: 'Processing' },
  waiting_for_input: { tone: 'warning', label: 'Waiting' },
  rate_limit_cooldown: { tone: 'warning', label: 'Rate Limited' },
  interrupted: { tone: 'danger', label: 'Interrupted' },
};

export type SessionProcessingPhase = Extract<
  AgentProcessingState,
  { status: 'processing' }
>['phase'];

export const SESSION_PROCESSING_PHASE_CONFIG: Record<
  SessionProcessingPhase,
  SessionProcessingConfig
> = {
  initializing: { tone: 'progress', label: 'Initializing' },
  thinking: { tone: 'info', label: 'Thinking' },
  streaming: { tone: 'success', label: 'Streaming' },
  finalizing: { tone: 'special', label: 'Finalizing' },
};

export function getAgentProcessingStateConfig(
  state: AgentProcessingState
): SessionProcessingConfig {
  const byStatus = SESSION_PROCESSING_STATUS_CONFIG as Partial<
    Record<string, SessionProcessingConfig>
  >;

  if (state.status === 'processing') {
    const byPhase = SESSION_PROCESSING_PHASE_CONFIG as Partial<
      Record<string, SessionProcessingConfig>
    >;
    return byPhase[state.phase] ?? SESSION_PROCESSING_STATUS_CONFIG.processing;
  }

  return byStatus[state.status] ?? SESSION_PROCESSING_STATUS_CONFIG.idle;
}

export function getAgentProcessingStateClasses(
  state: AgentProcessingState
): SessionProcessingClasses {
  return SESSION_PROCESSING_TONE_CLASSES[getAgentProcessingStateConfig(state).tone];
}
