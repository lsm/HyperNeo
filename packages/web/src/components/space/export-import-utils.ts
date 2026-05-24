/**
 * Shared utilities for Space export/import UI actions.
 */

import type { SpaceExportBundle } from '@neokai/shared';

/**
 * Triggers a browser file download for a JSON bundle.
 * Filename pattern: `{spaceName}-{type}-{date}.neokai.json`
 */
export function downloadBundle(
  bundle: SpaceExportBundle,
  spaceName: string,
  type: 'agents' | 'workflows' | 'bundle'
): void {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const safeName = spaceName.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const filename = `${safeName}-${type}-${date}.neokai.json`;

  const json = JSON.stringify(bundle, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Opens a file picker and resolves with the parsed JSON, or null if cancelled
 * or the file is invalid.
 */
export function pickImportFile(): Promise<SpaceExportBundle | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (value: SpaceExportBundle | null) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.neokai.json';

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        done(null);
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target?.result as string) as SpaceExportBundle;
          done(parsed);
        } catch {
          done(null);
        }
      };
      reader.onerror = () => done(null);
      reader.readAsText(file);
    };

    // Cancelled without picking
    input.oncancel = () => done(null);

    // Some browsers don't fire oncancel; detect via focus returning to window
    const handleFocus = () => {
      // Small delay so the onchange fires first if a file was selected
      setTimeout(() => {
        if (!input.files?.length) done(null);
      }, 300);
    };
    window.addEventListener('focus', handleFocus, { once: true });

    input.click();
  });
}
