import { t } from './i18n/index.ts';
import { toast } from './toast.ts';

function externalUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') {
      return url;
    }
  } catch {}
}

export function isDesktopLinkHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function openExternalLink(value: string): void {
  const url = externalUrl(value);
  if (!url) {
    toast.error(t('link.openFailed'));
    return;
  }
  const bridge = (
    window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string, args: { path: string }) => Promise<void> };
    }
  ).__TAURI_INTERNALS__;
  if (bridge) {
    void bridge
      .invoke('plugin:shell|open', { path: url.href })
      .catch(() => toast.error(t('link.openFailed')));
    return;
  }
  window.open(url.href, '_blank', 'noopener,noreferrer');
}

export function installDesktopExternalLinks(): void {
  if (!isDesktopLinkHost()) return;
  const open = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      (event.type === 'auxclick' ? event.button !== 1 : event.button !== 0)
    ) {
      return;
    }
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return;
    const url = externalUrl(anchor.href);
    if (!url || url.origin === location.origin) return;
    event.preventDefault();
    openExternalLink(url.href);
  };
  document.addEventListener('click', open);
  document.addEventListener('auxclick', open);
}
