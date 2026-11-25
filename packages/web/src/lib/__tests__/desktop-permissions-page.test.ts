import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window, type HTMLButtonElement } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

const page = resolve('../desktop/src-tauri/loading/permissions.html');
const script = resolve('../desktop/src-tauri/loading/permissions.js');

describe('desktop permissions page', () => {
  it('guides through both permissions in order and closes once both are enabled', async () => {
    const window = new Window();
    window.document.write(readFileSync(page, 'utf8'));
    let status = { accessibility: false, screenRecording: false };
    const invoke = vi.fn(async (command: string) =>
      command === 'desktop_permission_status' ? status : undefined
    );
    const poll = vi.fn<(refresh: () => Promise<void>, delay: number) => void>();
    Object.assign(window, { __TAURI_INTERNALS__: { invoke }, setTimeout: poll });
    const button = (id: string) => window.document.querySelector<HTMLButtonElement>(id)!;
    const refresh = async () => {
      await poll.mock.lastCall![0]();
    };
    try {
      window.eval(readFileSync(script, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(button('#open-accessibility').closest('section')?.hasAttribute('hidden')).toBe(false);
      expect(button('#open-screen-recording').closest('section')?.hasAttribute('hidden')).toBe(
        true
      );
      expect(poll).toHaveBeenLastCalledWith(expect.any(Function), 1000);
      button('#open-accessibility').click();
      expect(invoke).toHaveBeenCalledWith('open_desktop_permission_settings', {
        permission: 'accessibility',
      });

      status = { ...status, accessibility: true };
      await refresh();
      expect(button('#open-accessibility').closest('section')?.hasAttribute('hidden')).toBe(true);
      expect(button('#open-screen-recording').closest('section')?.hasAttribute('hidden')).toBe(
        false
      );
      button('#open-screen-recording').click();
      expect(invoke).toHaveBeenCalledWith('open_desktop_permission_settings', {
        permission: 'screenRecording',
      });
      expect(invoke).not.toHaveBeenCalledWith('plugin:window|close');

      const scheduled = poll.mock.calls.length;
      status = { ...status, screenRecording: true };
      await refresh();
      expect(invoke).toHaveBeenCalledWith('plugin:window|close');
      expect(poll).toHaveBeenCalledTimes(scheduled);
    } finally {
      await window.happyDOM.close();
    }
  });
});
