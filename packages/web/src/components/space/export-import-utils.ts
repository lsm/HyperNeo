import type { SpaceExportBundle } from '@hyperneo/shared';

export function downloadBundle(
  bundle: SpaceExportBundle,
  spaceName: string,
  type: 'agents' | 'workflows' | 'bundle'
): void {
  const date = new Date().toISOString().slice(0, 10);
  const safeName = spaceName.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const filename = `${safeName}-${type}-${date}.hyperneo.json`;

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
    input.accept = '.json,.hyperneo.json';

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

    input.oncancel = () => done(null);

    const handleFocus = () => {
      setTimeout(() => {
        if (!input.files?.length) done(null);
      }, 300);
    };
    window.addEventListener('focus', handleFocus, { once: true });

    input.click();
  });
}
