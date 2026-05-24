/**
 * ConnectionStatus Component
 *
 * Shows daemon connection and processing status:
 * - Connecting: Yellow dot + "Connecting..."
 * - Connected + idle: Green dot + "Ready"
 * - Disconnected: Gray dot + "Offline"
 * - Processing: Pulsing dot + dynamic action (e.g., "Reading files...", "Thinking...")
 */

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

export default function ConnectionStatus({
  connectionState,
  isProcessing,
  currentAction,
  streamingPhase,
}: ConnectionStatusProps) {
  const getStatus = () => {
    // Processing state takes priority with phase-specific colors
    if (isProcessing && currentAction) {
      // Phase-specific color coding
      let dotClass = 'bg-purple-500 animate-pulse';
      let textClass = 'text-purple-400';

      if (streamingPhase) {
        switch (streamingPhase) {
          case 'initializing':
            dotClass = 'bg-yellow-500 animate-pulse';
            textClass = 'text-yellow-400';
            break;
          case 'thinking':
            dotClass = 'bg-blue-500 animate-pulse';
            textClass = 'text-blue-400';
            break;
          case 'streaming':
            dotClass = 'bg-green-500 animate-pulse';
            textClass = 'text-green-400';
            break;
          case 'finalizing':
            dotClass = 'bg-purple-500 animate-pulse';
            textClass = 'text-purple-400';
            break;
        }
      }

      return {
        dotClass,
        text: currentAction,
        textClass,
      };
    }

    // Connection states
    if (connectionState === 'connected') {
      return {
        dotClass: 'bg-green-500',
        text: 'Ready',
        textClass: 'text-green-400',
      };
    }

    if (connectionState === 'connecting') {
      return {
        dotClass: 'bg-yellow-500 animate-pulse',
        text: 'Connecting...',
        textClass: 'text-yellow-400',
      };
    }

    if (connectionState === 'reconnecting') {
      return {
        dotClass: 'bg-yellow-500 animate-pulse',
        text: 'Reconnecting...',
        textClass: 'text-yellow-400',
      };
    }

    if (connectionState === 'failed' || connectionState === 'error') {
      return {
        dotClass: 'bg-red-500',
        text: 'Connection Failed',
        textClass: 'text-red-400',
      };
    }

    // disconnected
    return {
      dotClass: 'bg-gray-500',
      text: 'Offline',
      textClass: 'text-gray-500',
    };
  };

  const status = getStatus();

  return (
    <div class="flex items-center gap-2">
      <div class={`w-2 h-2 rounded-full ${status.dotClass}`} />
      {status.text && <span class={`text-xs font-medium ${status.textClass}`}>{status.text}</span>}
    </div>
  );
}
