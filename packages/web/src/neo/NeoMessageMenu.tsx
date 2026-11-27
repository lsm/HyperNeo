import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import { t } from '../lib/i18n/index.ts';

export type NeoMessageMenuAction = 'select' | 'copy' | 'reply';

const labels = {
  select: 'chat.selectText',
  copy: 'chat.copyMessage',
  reply: 'chat.reply',
} as const;

type MenuInput = { hasText: boolean; canReply: boolean };

export function requireNeoMessageMenuText(
  input: MenuInput
): { value: MenuInput } | { reason: NeoMessageMenuAction[] } {
  return input.hasText ? { value: input } : { reason: [] };
}

export function listNeoMessageMenuActions(input: MenuInput): NeoMessageMenuAction[] {
  return input.canReply ? ['select', 'copy', 'reply'] : ['select', 'copy'];
}

export const neoMessageMenuActions = (superpipe({})('neo-message-menu') as PipelineAPI)
  .input(['input'])
  .pipe(requireNeoMessageMenuText, 'input', 'result:actions')
  .pipe(listNeoMessageMenuActions, 'actions', 'actions')
  .end('actions') as (input: MenuInput) => NeoMessageMenuAction[];

const LONG_PRESS_MS = 500;

export function useNeoMessageMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchInput = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  const close = useCallback(() => setAt(null), []);
  return {
    at,
    close,
    bind: {
      onPointerDown: (event: PointerEvent) => {
        touchInput.current = event.pointerType === 'touch';
      },
      onKeyDown: () => {
        touchInput.current = false;
      },
      onContextMenu: (
        event: MouseEvent & {
          sourceCapabilities?: { firesTouchEvents: boolean } | null;
          pointerType?: string;
        }
      ) => {
        const touch =
          event.sourceCapabilities?.firesTouchEvents ??
          (event.pointerType ? event.pointerType === 'touch' : touchInput.current);
        if (touch) event.preventDefault();
      },
      onTouchStart: (event: TouchEvent) => {
        const touch = event.touches[0];
        if (!touch) return;
        touchInput.current = true;
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
  returnFocus,
}: {
  at: { x: number; y: number };
  actions: readonly NeoMessageMenuAction[];
  onPick: (action: NeoMessageMenuAction) => void;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const restore = useRef(returnFocus);
  restore.current = returnFocus;
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => restore.current?.()?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
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
      aria-label={t('chat.messageActions')}
      style={{
        left: `${Math.min(at.x, window.innerWidth - 176)}px`,
        top: `${Math.min(at.y, window.innerHeight - 48 * actions.length - 8)}px`,
      }}
      class="fixed z-50 w-40 overflow-hidden rounded-xl border border-line bg-surface py-1 text-sm shadow-lg"
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const index = items.indexOf(event.target as HTMLButtonElement);
        event.preventDefault();
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}
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
          {t(labels[action])}
        </button>
      ))}
    </div>
  );
}
