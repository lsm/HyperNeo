import { useEffect, useRef } from 'preact/hooks';
import { setupFocusTrap } from '../components/ui/Modal.tsx';
import ChatContainer from '../islands/ChatContainer.tsx';
import { SessionStore } from '../lib/session-store.ts';

export function NeoSessionPane({
  sessionId,
  title,
  overlay,
  onClose,
}: {
  sessionId: string;
  title: string;
  overlay: boolean;
  onClose: () => void;
}) {
  const pane = useRef<HTMLElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const store = useRef<SessionStore | null>(null);
  if (store.current === null) store.current = new SessionStore();
  useEffect(() => {
    const owned = store.current;
    return () => {
      owned?.destroy().catch(() => {});
    };
  }, []);
  useEffect(() => {
    pane.current?.focus();
  }, []);
  useEffect(() => {
    if (!overlay || !pane.current) return;
    const release = setupFocusTrap(pane.current);
    if (!pane.current.contains(document.activeElement)) pane.current.focus();
    return () => {
      release();
      opener.current?.focus?.();
    };
  }, [overlay]);
  return (
    <aside
      ref={pane}
      tabIndex={-1}
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay ? true : undefined}
      class="neo-session-pane flex flex-col outline-none"
      aria-label={`${title} chat`}
    >
      <ChatContainer key={sessionId} sessionId={sessionId} onBack={onClose} store={store.current} />
    </aside>
  );
}
