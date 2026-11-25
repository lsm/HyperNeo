import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlobalSettings, ProviderRecord } from '@hyperneo/shared';
import {
  createOxapSettingsOperations,
  readHubOptions,
  type OxapSettingsDeps,
} from '../../../../src/lib/oxap/oxap-settings';
import { releaseName } from '../../../../src/lib/oxap/oxap-install';
import { withProviderLock } from '../../../../src/lib/rpc-handlers/provider-mutation-lock';

vi.mock('@hyperneo/shared/types/oxap-harnesses', async (importOriginal) =>
  (await import('../../../helpers/synthetic-oxap-harness')).withSyntheticOxapRow(importOriginal)
);

const binary = { path: '/synthetic/oxap', version: releaseName(), sha256: 'a'.repeat(64) };

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function host(
  options: { failWrite?: boolean; failRestart?: boolean; keys?: Record<string, string> } = {}
) {
  const records: ProviderRecord[] = [
    'anthropic-codex',
    'synthetic-memory',
    'synthetic-memory-2',
  ].map(
    (providerId) =>
      ({ id: `id-${providerId}`, providerId, configJson: '{"models":["m"]}' }) as ProviderRecord
  );
  let settings: Pick<GlobalSettings, 'oxapHub'> = {};
  const install = vi.fn(async () => binary);
  const restart = vi.fn(async () => {
    if (options.failRestart) throw new Error('synthetic close failure');
  });
  const deps: OxapSettingsDeps = {
    settings: () => settings,
    writeHub: (oxapHub) => {
      settings = { oxapHub };
    },
    records: () => records.map((record) => ({ ...record })),
    writeProvider: async (id, configJson) => {
      if (options.failWrite) throw new Error('synthetic write failure');
      records.find((record) => record.id === id)!.configJson = configJson;
    },
    key: async (providerId) => options.keys?.[providerId],
    install,
    engine: { restart },
    stateDirectory: '/synthetic/state',
    environment: { HOME: '/synthetic/home' },
  };
  const directory = mkdtempSync(join(tmpdir(), 'oxap-settings-'));
  directories.push(directory);
  const codex = join(directory, 'codex');
  writeFileSync(codex, '#!/bin/sh\necho "Usage: codex app-server [OPTIONS]"\n', { mode: 0o700 });
  const [save] = createOxapSettingsOperations(deps);
  const run = (input: Record<string, unknown>) =>
    save.execute(input, { source: 'rpc' } as never) as Promise<{
      accepted: boolean;
      reason?: string;
    }>;
  return { deps, records, install, restart, run, codex, directory };
}

describe('oxap.settings.save', () => {
  it('installs the hub, saves the harness, restarts, and the next hub start reads the saved entry', async () => {
    const h = host();
    expect(
      await h.run({
        providerId: 'anthropic-codex',
        harness: 'oxap-codex',
        settings: { executable: h.codex },
      })
    ).toEqual({ accepted: true });
    expect(JSON.parse(h.records[0].configJson!)).toEqual({
      models: ['m'],
      harness: 'oxap-codex',
      harnessSettings: { executable: h.codex },
    });
    expect(h.install).toHaveBeenCalledOnce();
    expect(h.restart).toHaveBeenCalledOnce();
    const next = await readHubOptions(h.deps);
    expect(next).toMatchObject({
      binaryPath: '/synthetic/oxap',
      identity: { version: releaseName(), sha256: 'a'.repeat(64) },
      stateDirectory: '/synthetic/state',
      hub: {
        adapters: { 'anthropic-codex': { type: 'codex', executable: h.codex } },
        environment: { HOME: '/synthetic/home' },
      },
    });
  });

  it('refuses a harness the provider cannot run or a relative path, before writing or restarting', async () => {
    const h = host();
    expect(await h.run({ providerId: 'synthetic-memory', harness: 'oxap-codex' })).toEqual({
      accepted: false,
      reason: 'synthetic-memory cannot run on oxap-codex',
    });
    expect(
      await h.run({
        providerId: 'anthropic-codex',
        harness: 'oxap-codex',
        settings: { executable: 'codex' },
      })
    ).toEqual({ accepted: false, reason: 'anthropic-codex needs an absolute executable path' });
    expect(h.records.map((record) => record.configJson)).toEqual(Array(3).fill('{"models":["m"]}'));
    expect(h.install).not.toHaveBeenCalled();
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('refuses missing, non-executable and wrong CLI paths without restarting', async () => {
    const h = host();
    const wrong = join(h.directory, 'oxap');
    const nonExecutable = join(h.directory, 'not-executable');
    writeFileSync(wrong, '#!/bin/sh\necho "Usage: oxap"\n', { mode: 0o700 });
    writeFileSync(nonExecutable, '#!/bin/sh\n', { mode: 0o600 });
    for (const [executable, reason] of [
      [join(h.directory, 'missing'), 'must point to an executable file'],
      [nonExecutable, 'must point to an executable file'],
      [wrong, 'did not respond as the Codex CLI'],
    ]) {
      expect(
        await h.run({
          providerId: 'anthropic-codex',
          harness: 'oxap-codex',
          settings: { executable },
        })
      ).toEqual({ accepted: false, reason: expect.stringContaining(reason) });
    }
    expect(h.install).not.toHaveBeenCalled();
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('refuses a provider whose stored config is unreadable, without writing or restarting', async () => {
    const h = host();
    h.records[0].configJson = '{';
    expect(
      await h.run({
        providerId: 'anthropic-codex',
        harness: 'oxap-codex',
        settings: { executable: h.codex },
      })
    ).toEqual({ accepted: false, reason: 'anthropic-codex has an unreadable config' });
    expect(h.records[0].configJson).toBe('{');
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('refuses two providers whose harness reads one key variable with different keys', async () => {
    const h = host({ keys: { 'synthetic-memory': 'sk-a', 'synthetic-memory-2': 'sk-b' } });
    expect(await h.run({ providerId: 'synthetic-memory', harness: 'oxap-synthetic' })).toEqual({
      accepted: true,
    });
    expect(await h.run({ providerId: 'synthetic-memory-2', harness: 'oxap-synthetic' })).toEqual({
      accepted: false,
      reason:
        'synthetic-memory and synthetic-memory-2 both set SYNTHETIC_API_KEY to different keys',
    });
    expect(h.records[2].configJson).toBe('{"models":["m"]}');
    expect(h.install).toHaveBeenCalledOnce();
    expect(h.restart).toHaveBeenCalledOnce();
  });

  it('puts the key in the hub environment only, named in the entry', async () => {
    const h = host({ keys: { 'synthetic-memory': 'sk-a' } });
    await h.run({ providerId: 'synthetic-memory', harness: 'oxap-synthetic' });
    expect(await h.run({ providerId: 'synthetic-memory', harness: 'sdk' })).toEqual({
      accepted: true,
    });
    const next = await readHubOptions(h.deps);
    expect(next.hub.adapters['synthetic-memory']).toEqual({
      type: 'memory',
      environment: ['SYNTHETIC_API_KEY'],
    });
    expect(next.hub.environment.SYNTHETIC_API_KEY).toBe('sk-a');
  });

  it('changes nothing when the settings write fails', async () => {
    const h = host({ failWrite: true });
    await expect(
      h.run({
        providerId: 'anthropic-codex',
        harness: 'oxap-codex',
        settings: { executable: h.codex },
      })
    ).rejects.toThrow('synthetic write failure');
    expect(h.records[0].configJson).toBe('{"models":["m"]}');
    expect(h.deps.settings().oxapHub).toBeUndefined();
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('keeps the saved settings when restart fails, so the next hub start uses them', async () => {
    const h = host({ failRestart: true });
    await expect(
      h.run({
        providerId: 'anthropic-codex',
        harness: 'oxap-codex',
        settings: { executable: h.codex },
      })
    ).rejects.toThrow('synthetic close failure');
    expect(JSON.parse(h.records[0].configJson!).harness).toBe('oxap-codex');
    expect((await readHubOptions(h.deps)).hub.adapters['anthropic-codex']).toMatchObject({
      executable: h.codex,
    });
  });

  it('keeps the configured adapter when a provider switches back to Claude Code', async () => {
    const h = host();
    await h.run({
      providerId: 'anthropic-codex',
      harness: 'oxap-codex',
      settings: { executable: h.codex },
    });
    h.install.mockClear();
    expect(await h.run({ providerId: 'anthropic-codex', harness: 'sdk' })).toEqual({
      accepted: true,
    });
    expect(JSON.parse(h.records[0].configJson!)).toEqual({
      models: ['m'],
      harnessSettings: { executable: h.codex },
    });
    const replacement = join(h.directory, 'replacement-codex');
    writeFileSync(replacement, '#!/bin/sh\necho "Usage: codex app-server [OPTIONS]"\n', {
      mode: 0o700,
    });
    expect(
      await h.run({
        providerId: 'anthropic-codex',
        harness: 'sdk',
        settings: { executable: replacement },
      })
    ).toEqual({ accepted: true });
    expect(h.install).not.toHaveBeenCalled();
    expect((await readHubOptions(h.deps)).hub.adapters).toMatchObject({
      'anthropic-codex': { executable: replacement },
    });
  });

  it('keeps other providers on the hub when one stored harness setting is broken', async () => {
    const h = host();
    await h.run({ providerId: 'synthetic-memory', harness: 'oxap-synthetic' });
    h.records[0].configJson = '{"harness":"oxap-codex"}';
    expect(Object.keys((await readHubOptions(h.deps)).hub.adapters)).toEqual(['synthetic-memory']);
  });

  it('runs saves one at a time so a later save sees the earlier one', async () => {
    const h = host({ keys: { 'synthetic-memory': 'sk-a', 'synthetic-memory-2': 'sk-b' } });
    const results = await Promise.all([
      h.run({ providerId: 'synthetic-memory', harness: 'oxap-synthetic' }),
      h.run({ providerId: 'synthetic-memory-2', harness: 'oxap-synthetic' }),
    ]);
    expect(results.map((result) => result.accepted)).toEqual([true, false]);
  });

  it('installs the hub without holding the provider lock', async () => {
    const h = host();
    let finish: (value: typeof binary) => void = () => {};
    h.install.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const saving = h.run({
      providerId: 'anthropic-codex',
      harness: 'oxap-codex',
      settings: { executable: h.codex },
    });
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledOnce());
    expect(await withProviderLock(async () => 'provider edit ran')).toBe('provider edit ran');
    finish(binary);
    expect(await saving).toEqual({ accepted: true });
  });

  it('upgrades a previously installed hub before using it', async () => {
    const h = host();
    const old = { ...binary, version: 'oxap-0.1.0-alpha.39-macos-arm64' };
    h.deps.writeHub(old);
    expect((await readHubOptions(h.deps)).identity.version).toBe(releaseName());
    expect(h.deps.settings().oxapHub).toEqual(binary);
    expect(h.install).toHaveBeenCalledWith(old);
  });

  it('refuses to start a hub before one is installed', async () => {
    await expect(readHubOptions(host().deps)).rejects.toThrow('OXAP hub is not installed');
  });
});
