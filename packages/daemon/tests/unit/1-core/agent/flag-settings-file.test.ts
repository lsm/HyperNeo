import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'bun:test';
import { createFlagSettingsFileWriter } from '../../../../src/lib/agent/flag-settings-file.ts';

const SECRET = 'sk-ant-oat01-flag-settings-secret';

describe('SDK flag settings file', () => {
  const roots: string[] = [];
  const writer = () => {
    const root = mkdtempSync(join(tmpdir(), 'flag-settings-test-'));
    roots.push(root);
    return createFlagSettingsFileWriter(root);
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('keeps credential env out of the options the SDK turns into argv', () => {
    const options: Options = {
      settings: { cleanupPeriodDays: 3650, env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET } },
      sandbox: { enabled: true },
    };
    writer()(options, 'session/1');

    expect(JSON.stringify(options)).not.toContain(SECRET);
    expect(options.sandbox).toBeUndefined();
    const path = options.settings as string;
    expect(path.endsWith('session_1.json')).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      cleanupPeriodDays: 3650,
      env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET },
      sandbox: { enabled: true, failIfUnavailable: true },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  it('keeps an explicit failIfUnavailable and reuses one directory per writer', () => {
    const write = writer();
    const first: Options = {
      settings: { env: { ANTHROPIC_API_KEY: SECRET } },
      sandbox: { enabled: true, failIfUnavailable: false },
    };
    const second: Options = { settings: { env: { ANTHROPIC_API_KEY: SECRET } } };
    write(first, 'a');
    write(second, 'b');

    expect(JSON.parse(readFileSync(first.settings as string, 'utf8')).sandbox).toEqual({
      enabled: true,
      failIfUnavailable: false,
    });
    expect(JSON.parse(readFileSync(second.settings as string, 'utf8'))).toEqual({
      env: { ANTHROPIC_API_KEY: SECRET },
    });
    expect(dirname(first.settings as string)).toBe(dirname(second.settings as string));
  });

  it('leaves settings without env inline', () => {
    const options: Options = { settings: { cleanupPeriodDays: 3650 }, sandbox: { enabled: true } };
    writer()(options, 'a');
    expect(options).toEqual({
      settings: { cleanupPeriodDays: 3650 },
      sandbox: { enabled: true },
    });
  });
});
