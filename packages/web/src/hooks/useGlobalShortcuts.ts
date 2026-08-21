import { useEffect } from 'preact/hooks';
import { commandRegistry } from '../lib/command-registry.ts';
import { commandPaletteModeSignal, commandPaletteOpenSignal } from '../lib/signals.ts';

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return type !== 'checkbox' && type !== 'radio' && type !== 'button';
  }
  return tag === 'TEXTAREA' || tag === 'SELECT';
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform ?? '';
  if (platform) return /Mac|iPhone|iPad|iPod/i.test(platform);
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent ?? '');
}

function isPaletteShortcut(event: KeyboardEvent, isMac: boolean): 'commands' | 'quick-open' | null {
  if (event.shiftKey || event.altKey) return null;
  if (event.code !== 'KeyK' && event.code !== 'KeyP') return null;
  const hasPlatformMod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!hasPlatformMod) return null;
  return event.code === 'KeyK' ? 'commands' : 'quick-open';
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const isMac = isMacPlatform();

    const handler = (event: KeyboardEvent) => {
      if (event.repeat) return;

      const paletteMode = isPaletteShortcut(event, isMac);
      if (paletteMode) {
        event.preventDefault();
        if (commandPaletteOpenSignal.value && commandPaletteModeSignal.value === paletteMode) {
          commandPaletteOpenSignal.value = false;
          return;
        }
        commandPaletteModeSignal.value = paletteMode;
        commandPaletteOpenSignal.value = true;
        return;
      }

      if (isTextEditingTarget(event.target)) return;

      const cmd = commandRegistry.findByShortcut(event);
      if (!cmd) return;
      event.preventDefault();
      void (async () => {
        try {
          await cmd.run();
        } catch (err) {
          try {
            const { toast } = await import('../lib/toast.ts');
            toast.error(err instanceof Error ? err.message : `Command "${cmd.label}" failed`);
          } catch {}
        }
      })();
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
