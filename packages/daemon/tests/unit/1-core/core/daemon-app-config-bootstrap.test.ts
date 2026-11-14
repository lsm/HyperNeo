import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_CONFIG_KEY_CATALOG } from '@hyperneo/shared';
import { createDaemonApp, type DaemonAppContext } from '../../../../src/app';
import type { Config } from '../../../../src/config';

if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
  (globalThis as { Bun?: unknown }).Bun = {
    serve: () => ({ stop() {} }),
  };
}

function readConfigOverlay(ctx: DaemonAppContext): Record<string, unknown> {
  const row = ctx.db
    .getDatabase()
    .prepare(`SELECT config_json FROM daemon_config WHERE id = 1`)
    .get() as { config_json: string } | null | undefined;
  return row ? (JSON.parse(row.config_json) as Record<string, unknown>) : {};
}

describe('Daemon App daemon-config bootstrap', () => {
  let config: Config;
  let originalTestUserSettingsDir: string | undefined;
  let bunServeSpy: ReturnType<typeof spyOn> | null = null;
  const savedCatalogEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const entry of DAEMON_CONFIG_KEY_CATALOG) {
      savedCatalogEnv.set(entry.legacyEnvName, process.env[entry.legacyEnvName]);
      delete process.env[entry.legacyEnvName];
    }
    originalTestUserSettingsDir = process.env.TEST_USER_SETTINGS_DIR;
    process.env.TEST_USER_SETTINGS_DIR = join(tmpdir(), `hyperneo-test-settings-${Date.now()}`);
    bunServeSpy = spyOn(Bun, 'serve').mockImplementation(
      (_opts: Parameters<typeof Bun.serve>[0]) =>
        ({
          stop() {},
        }) as never
    );
    config = {
      host: 'localhost',
      port: 0,
      defaultModel: 'claude-sonnet-4-5-20250929',
      maxTokens: 8192,
      temperature: 1.0,
      dbPath: ':memory:',
      maxSessions: 10,
      maxSubscriptionsPerClient: 128,
      nodeEnv: 'test',
      disableWorktrees: true,
      structuredLogMaxBytes: 10 * 1024 * 1024,
      structuredLogRetainedFiles: 5,
      structuredLogMaxPendingBytes: 2 * 1024 * 1024,
    };
  });

  afterEach(() => {
    for (const [name, value] of savedCatalogEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    savedCatalogEnv.clear();
    if (originalTestUserSettingsDir !== undefined) {
      process.env.TEST_USER_SETTINGS_DIR = originalTestUserSettingsDir;
    } else {
      delete process.env.TEST_USER_SETTINGS_DIR;
    }
    if (bunServeSpy) {
      bunServeSpy.mockRestore();
      bunServeSpy = null;
    }
  });

  test('seeds a set legacy env var into the daemon_config row at boot', {
    timeout: 20_000,
  }, async () => {
    process.env.HYPERNEO_MESSAGE_DELIVERY_MAX_CONCURRENT = '7';
    const daemonContext = await createDaemonApp({
      config,
      verbose: false,
      standalone: false,
    });
    try {
      expect(readConfigOverlay(daemonContext)).toEqual({
        deliveryPolicy: { messageDeliveryMaxConcurrent: 7 },
      });
      expect(
        daemonContext.daemonConfigService.getConfig().deliveryPolicy?.messageDeliveryMaxConcurrent
      ).toBe(7);
    } finally {
      await daemonContext.cleanup();
    }
  });

  test('seeds exactly once across restarts against a persistent DB', {
    timeout: 40_000,
  }, async () => {
    const tmpDir = join(
      tmpdir(),
      `hyperneo-dc04-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
    const dbPath = join(tmpDir, 'daemon.db');
    try {
      process.env.HYPERNEO_MESSAGE_DELIVERY_MAX_CONCURRENT = '7';
      const firstBoot = await createDaemonApp({
        config: { ...config, dbPath },
        verbose: false,
        standalone: false,
      });
      await firstBoot.cleanup();

      process.env.HYPERNEO_MESSAGE_DELIVERY_MAX_CONCURRENT = '11';
      const secondBoot = await createDaemonApp({
        config: { ...config, dbPath },
        verbose: false,
        standalone: false,
      });
      try {
        expect(readConfigOverlay(secondBoot)).toEqual({
          deliveryPolicy: { messageDeliveryMaxConcurrent: 7 },
        });
        expect(
          secondBoot.daemonConfigService.getConfig().deliveryPolicy?.messageDeliveryMaxConcurrent
        ).toBe(7);
      } finally {
        await secondBoot.cleanup();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('boots without legacy env vars and serves catalog defaults', {
    timeout: 20_000,
  }, async () => {
    const daemonContext = await createDaemonApp({
      config,
      verbose: false,
      standalone: false,
    });
    try {
      expect(readConfigOverlay(daemonContext)).toEqual({});
      expect(
        daemonContext.daemonConfigService.getConfig().deliveryPolicy?.messageDeliveryMaxConcurrent
      ).toBe(64);
    } finally {
      await daemonContext.cleanup();
    }
  });
});
