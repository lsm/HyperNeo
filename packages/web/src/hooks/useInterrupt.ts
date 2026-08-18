import { useState, useEffect, useCallback } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';

export interface UseInterruptOptions {
  sessionId: string;
}

export interface UseInterruptResult {
  interrupting: boolean;
  handleInterrupt: () => Promise<void>;
}

export function useInterrupt({ sessionId }: UseInterruptOptions): UseInterruptResult {
  const [interrupting, setInterrupting] = useState(false);

  useEffect(() => {
    setInterrupting(false);
  }, [sessionId]);

  const handleInterrupt = useCallback(async () => {
    if (interrupting) return;

    try {
      setInterrupting(true);
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        toast.error('Not connected to server');
        return;
      }
      await hub.request('client.interrupt', { sessionId });
    } catch {
      toast.error('Failed to stop generation');
    } finally {
      setTimeout(() => setInterrupting(false), 500);
    }
  }, [sessionId, interrupting]);

  return {
    interrupting,
    handleInterrupt,
  };
}
