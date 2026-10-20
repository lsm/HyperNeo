import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../../../../src/storage/database.ts';
import { SettingsManager } from '../../../../src/lib/settings-manager.ts';
import { EventLoopActivity } from '../../../../src/lib/event-loop-activity.ts';
import { delayedSettings } from '../../../helpers/delayed-settings.ts';

test.each(['workspace', 'user'])('slow %s settings keep the daemon responsive', async (source) => {
  const run = mkdtempSync(join(tmpdir(), 'hn-settings-response-'));
  const home = join(run, 'home');
  const workspace = join(run, 'workspace');
  const userSettings = join(home, '.claude');
  const localSettings = join(workspace, '.claude/settings.local.json');
  mkdirSync(join(workspace, '.claude'), { recursive: true });
  mkdirSync(userSettings, { recursive: true });
  const previous = process.env.TEST_USER_SETTINGS_DIR;
  process.env.TEST_USER_SETTINGS_DIR = userSettings;
  const writer = await delayedSettings(
    source === 'workspace' ? localSettings : join(userSettings, 'settings.json'),
    home,
    400
  );
  const db = { getGlobalSettings: () => ({ outputStyle: 'concise' }) } as Database;
  const activity = new EventLoopActivity();
  const stop = activity.activate();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let responsive = false;
    timer = setTimeout(() => {
      responsive = true;
    }, 20);
    await new SettingsManager(db, workspace).prepareSDKOptions();
    expect(responsive).toBe(true);
    const phases = activity.drain().entries;
    expect(phases.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'sdk:settings_prepare', kind: 'start' },
      { name: 'sdk:settings_prepare', kind: 'end' },
    ]);
    expect(phases[1].durationMs).toBeGreaterThanOrEqual(400);
    await writer.done;
    const saved = JSON.parse(readFileSync(localSettings, 'utf8'));
    expect(saved.outputStyle).toBe('concise');
    expect(saved.attribution).toEqual({ commit: 'synthetic' });
    if (source === 'workspace') expect(saved.custom).toBe('preserved');
  } finally {
    stop();
    clearTimeout(timer);
    if (previous === undefined) delete process.env.TEST_USER_SETTINGS_DIR;
    else process.env.TEST_USER_SETTINGS_DIR = previous;
    await writer.stop();
    rmSync(run, { recursive: true, force: true });
  }
});
