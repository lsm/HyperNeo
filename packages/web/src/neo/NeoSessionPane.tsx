import { useEffect, useRef } from 'preact/hooks';
import ChatContainer from '../islands/ChatContainer.tsx';
import { SessionStore } from '../lib/session-store.ts';

export function NeoSessionPane({
  sessionId,
  title,
  onClose,
}: {
  sessionId: string;
  title: string;
  onClose: () => void;
}) {
  const store = useRef<SessionStore | null>(null);
  if (store.current === null) store.current = new SessionStore();
  useEffect(() => {
    const owned = store.current;
    return () => {
      owned?.destroy().catch(() => {});
    };
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);
  return (
    <aside class="neo-session-pane flex flex-col" aria-label={`${title} chat`}>
      <ChatContainer key={sessionId} sessionId={sessionId} onBack={onClose} store={store.current} />
    </aside>
  );
}
