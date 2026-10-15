import { useEffect, useRef, useState } from 'preact/hooks';

export type NeoMessageMenuAction = 'select' | 'copy' | 'share' | 'reply';

const labels: Record<NeoMessageMenuAction, string> = {
  select: 'Select text',
  copy: 'Copy',
  share: 'Share',
  reply: 'Reply',
};

export function neoMessageMenuActions({
  canShare,
  canReply,
}: {
  canShare: boolean;
  canReply: boolean;
}): NeoMessageMenuAction[] {
  return [
    'select',
    'copy',
    ...(canShare ? (['share'] as const) : []),
    ...(canReply ? (['reply'] as const) : []),
  ];
}

const LONG_PRESS_MS = 500;

export function useNeoMessageMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  return {
    at,
    close: () => setAt(null),
    bind: {
      onContextMenu: (event: MouseEvent) => {
        event.preventDefault();
        setAt({ x: event.clientX, y: event.clientY });
      },
      onTouchStart: (event: TouchEvent) => {
        const touch = event.touches[0];
        if (!touch) return;
        cancel();
        timer.current = setTimeout(
          () => setAt({ x: touch.clientX, y: touch.clientY }),
          LONG_PRESS_MS
        );
      },
      onTouchMove: cancel,
      onTouchEnd: cancel,
    },
  };
}

export function NeoMessageMenu({
  at,
  actions,
  onPick,
  onClose,
}: {
  at: { x: number; y: number };
  actions: readonly NeoMessageMenuAction[];
  onPick: (action: NeoMessageMenuAction) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const away = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);
  return (
    <div
      ref={menu}
      role="menu"
      aria-label="Message actions"
      style={{
        left: `${Math.min(at.x, window.innerWidth - 176)}px`,
        top: `${Math.min(at.y, window.innerHeight - 48 * actions.length - 8)}px`,
      }}
      class="fixed z-50 w-40 overflow-hidden rounded-xl border border-line bg-surface py-1 text-sm shadow-lg"
    >
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          role="menuitem"
          class="block w-full px-3 py-2 text-left hover:bg-fill-soft focus-visible:bg-fill-soft focus-visible:outline-none"
          onClick={() => {
            onClose();
            onPick(action);
          }}
        >
          {labels[action]}
        </button>
      ))}
    </div>
  );
}
