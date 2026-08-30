import { useEffect, useState } from 'preact/hooks';
import { Modal } from '../ui/Modal.tsx';
import { listRuntimeMcpServers } from '../../lib/api-helpers.ts';

const RUNTIME_MCP_LABELS: Record<string, { title: string; description: string }> = {
  'space-agent-tools': {
    title: 'Space coordination',
    description: 'send_message_to_agent, list_peers, task management',
  },
  'db-query': {
    title: 'Database queries',
    description: 'Read-only SQLite access scoped to this space',
  },
  'task-agent': {
    title: 'Task agent',
    description: 'Workflow execution, node activation, sub-agent spawning',
  },
  'node-agent': {
    title: 'Node agent',
    description: 'Workflow node tools: peers, channels, gates',
  },
  'room-tools': {
    title: 'Room tools',
    description: 'Room-scoped coordination between co-located agents',
  },
};

interface TaskToolsModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string | null;
  agentLabel: string;
}

export function TaskToolsModal({ isOpen, onClose, sessionId, agentLabel }: TaskToolsModalProps) {
  const [servers, setServers] = useState<Array<{ name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !sessionId) {
      setServers([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    listRuntimeMcpServers(sessionId)
      .then((res) => {
        if (cancelled) return;
        setServers(res.servers ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load tools');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, sessionId]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`${agentLabel} Tools`} size="sm">
      <div class="space-y-3">
        {!sessionId && (
          <p class="text-sm text-fg-muted text-center py-4">
            Agent tools will be available after the agent starts.
          </p>
        )}

        {sessionId && loading && (
          <div class="flex items-center justify-center py-4 gap-2">
            <div class="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span class="text-sm text-fg-muted">Loading tools...</span>
          </div>
        )}

        {sessionId && error && <p class="text-sm text-danger-soft text-center py-4">{error}</p>}

        {sessionId && !loading && !error && servers.length === 0 && (
          <p class="text-sm text-fg-muted text-center py-4">
            No runtime tools registered for this agent.
          </p>
        )}

        {sessionId &&
          !loading &&
          !error &&
          servers.map((server) => {
            const label = RUNTIME_MCP_LABELS[server.name];
            return (
              <div
                key={server.name}
                class={`flex items-center gap-3 p-3 rounded-lg bg-surface-raised/50 min-w-0 border border-line-strong`}
              >
                <svg
                  class="w-4 h-4 text-success flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-fg-soft truncate">{label?.title ?? server.name}</div>
                  <div class="text-xs text-fg-muted truncate">
                    {label?.description ?? server.name}
                  </div>
                </div>
              </div>
            );
          })}
      </div>
    </Modal>
  );
}
