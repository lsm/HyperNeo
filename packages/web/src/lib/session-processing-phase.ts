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
