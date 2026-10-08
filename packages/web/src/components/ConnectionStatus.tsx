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
  activity?: string;
  streamingPhase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null;
}

interface StatusResult {
  tone: SessionProcessingTone;
  pulse: boolean;
  text: string;
}

function resolveStatus({
  isProcessing,
  currentAction,
  activity,
  streamingPhase,
}: Omit<ConnectionStatusProps, 'connectionState'>): StatusResult {
  if (isProcessing && currentAction) {
    const byPhase = SESSION_PROCESSING_PHASE_CONFIG as Partial<
      Record<string, SessionProcessingConfig>
    >;
    const config = byPhase[streamingPhase ?? ''] ?? SESSION_PROCESSING_STATUS_CONFIG.processing;
    return { tone: config.tone, pulse: true, text: currentAction };
  }

  return activity
    ? { tone: SESSION_PROCESSING_STATUS_CONFIG.processing.tone, pulse: true, text: activity }
    : { tone: 'success', pulse: false, text: 'Ready' };
}

export default function ConnectionStatus({
  connectionState,
  isProcessing,
  currentAction,
  activity,
  streamingPhase,
}: ConnectionStatusProps) {
  if (connectionState !== 'connected') return null;
  const status = resolveStatus({
    isProcessing,
    currentAction,
    activity,
    streamingPhase,
  });

  return (
    <div class="flex items-center gap-2">
      <StatusDot tone={status.tone} pulse={status.pulse} />
      {status.text && (
        <span class={`text-xs font-medium ${toneTextClasses[status.tone]}`}>{status.text}</span>
      )}
    </div>
  );
}
