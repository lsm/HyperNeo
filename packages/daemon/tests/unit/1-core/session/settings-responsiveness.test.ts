import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test.each(['another session', 'external edit'])(
  'preserves %s updates while user attribution is delayed',
  async (actor) => {
    const run = mkdtempSync(join(tmpdir(), 'hn-settings-overlap-'));
    const home = join(run, 'home');
    const workspace = join(run, 'workspace');
    const userSettings = join(home, '.claude');
    const localSettings = join(workspace, '.claude/settings.local.json');
    mkdirSync(join(workspace, '.claude'), { recursive: true });
    mkdirSync(userSettings, { recursive: true });
    writeFileSync(localSettings, JSON.stringify({ custom: 'preserved' }));
    const previous = process.env.TEST_USER_SETTINGS_DIR;
    process.env.TEST_USER_SETTINGS_DIR = userSettings;
    const writer = await delayedSettings(join(userSettings, 'settings.json'), home, 400);
    const first = new SettingsManager(
      { getGlobalSettings: () => ({ askPermissions: ['Read'] }) } as Database,
      workspace
    );
    let preparing: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      preparing = first.prepareSDKOptions();
      await writer.reading;
      if (actor === 'another session') {
        second = new SettingsManager(
          {
            getGlobalSettings: () => ({
              outputStyle: 'concise',
              attribution: { commit: 'second' },
            }),
          } as Database,
          workspace
        ).prepareSDKOptions();
      } else
        writeFileSync(localSettings, JSON.stringify({ custom: 'edited', outputStyle: 'concise' }));
      await Promise.all([preparing, second]);
      const saved = JSON.parse(readFileSync(localSettings, 'utf8'));
      expect(saved.permissions.ask).toEqual(['Read']);
      expect(saved.outputStyle).toBe('concise');
      expect(saved.custom).toBe(actor === 'another session' ? 'preserved' : 'edited');
    } finally {
      await writer.stop();
      await Promise.allSettled([preparing, second].filter(Boolean));
      if (previous === undefined) delete process.env.TEST_USER_SETTINGS_DIR;
      else process.env.TEST_USER_SETTINGS_DIR = previous;
      rmSync(run, { recursive: true, force: true });
    }
  }
);
