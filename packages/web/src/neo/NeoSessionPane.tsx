import { useEffect, useRef } from 'preact/hooks';
import { setupFocusTrap } from '../components/ui/Modal.tsx';
import ChatContainer from '../islands/ChatContainer.tsx';
import { SessionStore } from '../lib/session-store.ts';

const escapeOwners = '[role="dialog"], [role="menu"]';

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
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector(escapeOwners)) return;
      onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);
  useEffect(() => {
    if (!overlay || !pane.current) return;
    const previous = document.activeElement as HTMLElement | null;
    const release = setupFocusTrap(pane.current);
    return () => {
      release();
      previous?.focus?.();
    };
  }, [overlay]);
  return (
    <aside ref={pane} class="neo-session-pane flex flex-col" aria-label={`${title} chat`}>
      <ChatContainer key={sessionId} sessionId={sessionId} onBack={onClose} store={store.current} />
    </aside>
  );
}
