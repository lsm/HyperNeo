/**
 * Session Processing Phase Mapping
 *
 * Maps agent processing states and phases to indicator tones and labels.
 */

import type { AgentProcessingState } from '@hyperneo/shared';
import { getToneClasses, type IndicatorTone, type ToneClassSet } from './indicator-tokens.js';

/**
 * Configuration for a single processing state or phase.
 */
export interface SessionProcessingConfig {
  tone: IndicatorTone;
  label: string;
}

/**
 * Maps top-level processing statuses to their canonical tone and label.
 */
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

/**
 * Processing phases available when status is 'processing'.
 */
export type SessionProcessingPhase = Extract<
  AgentProcessingState,
  { status: 'processing' }
>['phase'];

/**
 * Maps processing phases to their canonical tone and label.
 */
export const SESSION_PROCESSING_PHASE_CONFIG: Record<
  SessionProcessingPhase,
  SessionProcessingConfig
> = {
  initializing: { tone: 'progress', label: 'Initializing' },
  thinking: { tone: 'info', label: 'Thinking' },
  streaming: { tone: 'success', label: 'Streaming' },
  finalizing: { tone: 'special', label: 'Finalizing' },
};

/**
 * Resolve the tone + label config for an agent processing state.
 * When the state is 'processing', the phase config is returned.
 */
export function getAgentProcessingStateConfig(
  state: AgentProcessingState
): SessionProcessingConfig {
  if (state.status === 'processing') {
    // Persisted processingState JSON is only cast to the union, so an older
    // or unrecognized phase can survive at runtime. Fall back to the generic
    // 'processing' config — parity with getProcessingPhaseColor's default case.
    const byPhase = SESSION_PROCESSING_PHASE_CONFIG as Partial<
      Record<string, SessionProcessingConfig>
    >;
    return byPhase[state.phase] ?? SESSION_PROCESSING_STATUS_CONFIG.processing;
  }
  return SESSION_PROCESSING_STATUS_CONFIG[state.status];
}

/**
 * Resolve the indicator class set for an agent processing state.
 */
export function getAgentProcessingStateClasses(state: AgentProcessingState): ToneClassSet {
  return getToneClasses(getAgentProcessingStateConfig(state).tone);
}
