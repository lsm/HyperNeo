import { useEffect, useState } from 'preact/hooks';
import { navigateToSpaceAgent } from '../lib/router';
import { spaceStore } from '../lib/space-store';
import ChatContainer from './ChatContainer';

interface SpaceAgentChatProps {
  spaceId: string;
  navigationSpaceId: string;
  handle: string;
  onBack: () => void;
}

export function SpaceAgentChat({
  spaceId,
  navigationSpaceId,
  handle,
  onBack,
}: SpaceAgentChatProps) {
  const agent = spaceStore.agents.value.find((candidate) => candidate.handle === handle) ?? null;
  const loaded = spaceStore.configDataLoaded.value;
  const agentId = agent?.id ?? null;
  const sessionId = agent?.sessionId ?? null;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!agentId || sessionId) return;
    let cancelled = false;
    spaceStore.ensureAgentSession(agentId).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to start the session');
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, sessionId]);

  const refreshAgent = async () => {
    await spaceStore.refreshAgents();
    navigateToSpaceAgent(navigationSpaceId, handle, true);
  };

  if (sessionId) {
    return (
      <ChatContainer
        key={sessionId}
        sessionId={sessionId}
        onBack={onBack}
        onRefreshAgent={refreshAgent}
      />
    );
  }

  const message = !loaded
    ? null
    : !agent
      ? `No agent found for @${handle} in this space.`
      : (error ?? 'Starting the agent session…');

  return (
    <div
      class="flex-1 flex items-center justify-center bg-app-content"
      data-testid={agent ? 'space-agent-chat-pending' : 'space-agent-detail-missing'}
      data-space-id={spaceId}
    >
      {message ? (
        <p class="max-w-sm text-center text-sm text-fg-muted">{message}</p>
      ) : (
        <div class="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      )}
    </div>
  );
}
