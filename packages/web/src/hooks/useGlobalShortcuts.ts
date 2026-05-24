/**
 * Global keyboard shortcut hook.
 *
 * Listens for Cmd+K (mac) / Ctrl+K (non-mac) to open command mode, Cmd+P /
 * Ctrl+P to open quick-open mode, and dispatches any other shortcuts registered
 * on commands in the registry.
 *
 * Ignores key events that originate from text inputs / contenteditable nodes so
 * we don't hijack typing inside the chat composer. The palette toggle is also
 * allowed in inputs — except on macOS we never treat Ctrl+K as a palette toggle
 * because it's a native text-editing shortcut (kill-to-end-of-line).
 *
 * Auto-repeat keydown events are ignored so press-and-hold doesn't fire a
 * non-idempotent command (e.g. session.new) multiple times.
 */

import { useEffect } from 'preact/hooks';
import { commandRegistry } from '../lib/command-registry.ts';
import { commandPaletteModeSignal, commandPaletteOpenSignal } from '../lib/signals.ts';

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    // Allow shortcuts for non-text-like inputs (checkboxes, buttons)
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
  // On mac, only Cmd+K toggles. Ctrl+K is a native editing shortcut.
  // On non-mac, only Ctrl+K toggles.
  const hasPlatformMod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!hasPlatformMod) return null;
  return event.code === 'KeyK' ? 'commands' : 'quick-open';
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const isMac = isMacPlatform();

    const handler = (event: KeyboardEvent) => {
      // Skip auto-repeat: each shortcut fires once per physical press.
      if (event.repeat) return;

      // Palette shortcuts work everywhere, including inside text inputs.
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

      // Don't intercept other shortcuts while the user is typing.
      if (isTextEditingTarget(event.target)) return;

      const cmd = commandRegistry.findByShortcut(event);
      if (!cmd) return;
      event.preventDefault();
      void (async () => {
        try {
          await cmd.run();
        } catch (err) {
          // Surface to toast so users see the failure; swallow to keep the
          // boundary safe even if toast itself throws.
          try {
            const { toast } = await import('../lib/toast.ts');
            toast.error(err instanceof Error ? err.message : `Command "${cmd.label}" failed`);
          } catch {
            // ignore
          }
        }
      })();
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
