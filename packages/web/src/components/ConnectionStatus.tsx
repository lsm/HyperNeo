/**
 * ConnectionStatus Component
 *
 * Shows daemon connection and processing status, with all tones derived from
 * the unified indicator foundation so colors stay consistent across the UI:
 * - Connecting/Reconnecting: pulsing progress dot
 * - Connected + idle: static success dot + "Ready"
 * - Disconnected: static neutral dot + "Offline"
 * - Failed/Error: static danger dot + "Connection Failed"
 * - Processing: pulsing phase-colored dot + dynamic action
 */

import { INDICATOR_TONES, type IndicatorTone } from '../lib/indicator-tokens.ts';
import {
  SESSION_PROCESSING_PHASE_CONFIG,
  SESSION_PROCESSING_STATUS_CONFIG,
} from '../lib/session-processing-phase.ts';
import { StatusDot } from './ui/StatusDot.tsx';

interface ConnectionStatusProps {
  connectionState:
    | 'connecting'
    | 'connected'
    | 'disconnected'
    | 'error'
    | 'reconnecting'
    | 'failed';
  isProcessing: boolean;
  currentAction?: string;
  streamingPhase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null;
}

interface StatusResult {
  tone: IndicatorTone;
  pulse: boolean;
  text: string;
}

/**
 * Resolve the connection/processing state into a foundation tone + label.
 * Processing takes priority over the connection state; a known streaming phase
 * uses its phase tone, and a null/unknown phase falls back to the generic
 * 'processing' tone (info) from the foundation.
 */
function resolveStatus({
  connectionState,
  isProcessing,
  currentAction,
  streamingPhase,
}: ConnectionStatusProps): StatusResult {
  // Processing takes priority with phase-specific tones.
  if (isProcessing && currentAction) {
    const config = streamingPhase
      ? SESSION_PROCESSING_PHASE_CONFIG[streamingPhase]
      : SESSION_PROCESSING_STATUS_CONFIG.processing;
    return { tone: config.tone, pulse: true, text: currentAction };
  }

  switch (connectionState) {
    case 'connected':
      return { tone: 'success', pulse: false, text: 'Ready' };
    case 'connecting':
      return { tone: 'progress', pulse: true, text: 'Connecting...' };
    case 'reconnecting':
      return { tone: 'progress', pulse: true, text: 'Reconnecting...' };
    case 'failed':
    case 'error':
      return { tone: 'danger', pulse: false, text: 'Connection Failed' };
    default:
      // disconnected
      return { tone: 'neutral', pulse: false, text: 'Offline' };
  }
}

export default function ConnectionStatus({
  connectionState,
  isProcessing,
  currentAction,
  streamingPhase,
}: ConnectionStatusProps) {
  const status = resolveStatus({ connectionState, isProcessing, currentAction, streamingPhase });

  return (
    <div class="flex items-center gap-2">
      <StatusDot tone={status.tone} pulse={status.pulse} />
      {status.text && (
        <span class={`text-xs font-medium ${INDICATOR_TONES[status.tone].text}`}>
          {status.text}
        </span>
      )}
    </div>
  );
}
