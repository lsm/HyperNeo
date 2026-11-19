import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

const page = resolve('../desktop/src-tauri/loading/permissions.html');
const script = resolve('../desktop/src-tauri/loading/permissions.js');

describe('desktop permissions page', () => {
  it('shows missing permissions, opens their settings and refreshes after a grant', async () => {
    const window = new Window();
    window.document.write(readFileSync(page, 'utf8'));
    const invoke = vi.fn(async (command: string, args?: { permission: string }) => {
      if (command === 'desktop_permission_status') {
        return { accessibility: false, screenRecording: false };
      }
      return args;
    });
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
    window.eval(readFileSync(script, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.document.body.textContent).toContain('Accessibility');
    expect(window.document.body.textContent).toContain('Screen Recording');
    window.document.querySelector<HTMLButtonElement>('#open-accessibility')?.click();
    window.document.querySelector<HTMLButtonElement>('#open-screen-recording')?.click();
    expect(invoke).toHaveBeenCalledWith('open_desktop_permission_settings', {
      permission: 'accessibility',
    });
    expect(invoke).toHaveBeenCalledWith('open_desktop_permission_settings', {
      permission: 'screenRecording',
    });
    invoke.mockResolvedValueOnce({ accessibility: true, screenRecording: true });
    window.document.querySelector<HTMLButtonElement>('#check-again')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.document.body.textContent).toContain('All permissions are enabled');
    await window.happyDOM.close();
  });
});
