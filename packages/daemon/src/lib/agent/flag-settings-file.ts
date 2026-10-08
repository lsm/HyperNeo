import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

export function createFlagSettingsFileWriter(root: string = tmpdir()) {
  let dir: string | undefined;
  return (options: Options, sessionId: string): void => {
    const settings = options.settings;
    if (!settings || typeof settings !== 'object' || !settings.env) return;
    const sandbox = options.sandbox;
    const content = sandbox
      ? {
          ...settings,
          sandbox:
            sandbox.enabled === true && sandbox.failIfUnavailable === undefined
              ? { ...sandbox, failIfUnavailable: true }
              : sandbox,
        }
      : settings;
    dir ??= mkdtempSync(join(root, 'hyperneo-settings-'));
    const path = join(dir, `${sessionId.replace(/[^\w-]/g, '_')}.json`);
    writeFileSync(path, JSON.stringify(content), { mode: 0o600 });
    options.settings = path;
    delete options.sandbox;
  };
}
