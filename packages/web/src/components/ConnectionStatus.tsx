import {
  SESSION_PROCESSING_PHASE_CONFIG,
  SESSION_PROCESSING_STATUS_CONFIG,
  type SessionProcessingConfig,
  type SessionProcessingTone,
} from '../lib/session-processing-phase.ts';
import { StatusDot } from './ui/StatusDot.tsx';

const toneTextClasses: Record<SessionProcessingTone, string> = {
  neutral: 'text-fg-muted',
  info: 'text-accent',
  progress: 'text-warning',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  special: 'text-cat-purple',
};

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
  tone: SessionProcessingTone;
  pulse: boolean;
  text: string;
}

function resolveStatus({
  connectionState,
  isProcessing,
  currentAction,
  streamingPhase,
}: ConnectionStatusProps): StatusResult {
  if (isProcessing && currentAction) {
    const byPhase = SESSION_PROCESSING_PHASE_CONFIG as Partial<
      Record<string, SessionProcessingConfig>
    >;
    const config = byPhase[streamingPhase ?? ''] ?? SESSION_PROCESSING_STATUS_CONFIG.processing;
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
        <span class={`text-xs font-medium ${toneTextClasses[status.tone]}`}>{status.text}</span>
      )}
    </div>
  );
}
