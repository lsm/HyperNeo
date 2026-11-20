import { describe, expect, test } from 'bun:test';
import { OXAP_HARNESSES, type OxapHarness } from '@hyperneo/shared/types/oxap-harnesses';
import { buildHubConfig } from '../../../../src/lib/oxap/oxap-hub-config';

const codex = (providerId: string, settings: Record<string, string> = {}) => ({
  providerId,
  configJson: JSON.stringify({
    harness: 'oxap-codex',
    harnessSettings: { executable: '/synthetic/bin/codex', ...settings },
  }),
});

describe('OXAP DeepSeek', () => {
  test('keeps the exact session id from the hub work status link', () => {
    const harnesses: Readonly<Record<string, OxapHarness>> = OXAP_HARNESSES;
    const row = harnesses['oxap-deepseek'];
    expect(row?.providers).toContain('deepseek');
    expect(row.nativeId('deepseek://sessions/literal%2Fsegment/next?x=1#end')).toBe(
      'literal%2Fsegment/next?x=1#end'
    );
    expect(row.nativeId('codex://threads/literal%2Fsegment')).toBeUndefined();
  });
});

describe('buildHubConfig', () => {
  test('gives each OXAP provider its own adapter entry and lists environment names only', () => {
    const result = buildHubConfig(
      [codex('anthropic-codex'), { providerId: 'anthropic', configJson: '{}' }],
      OXAP_HARNESSES,
      { HOME: '/synthetic/home', CODEX_HOME: '/synthetic/codex-home', PATH: '/usr/bin' },
      {}
    );
    expect(result).toEqual({
      value: {
        adapters: {
          'anthropic-codex': {
            type: 'codex',
            executable: '/synthetic/bin/codex',
            environment: ['HOME', 'CODEX_HOME'],
            any_directory: true,
            approval_policy: 'on-request',
            sandbox: 'workspace-write',
          },
        },
        environment: { HOME: '/synthetic/home', CODEX_HOME: '/synthetic/codex-home' },
      },
    });
  });

  test('lists CODEX_HOME only when the human has set one', () => {
    const result = buildHubConfig([codex('anthropic-codex')], OXAP_HARNESSES, { HOME: '/h' }, {});
    expect(result).toMatchObject({
      value: {
        adapters: { 'anthropic-codex': { environment: ['HOME'] } },
        environment: { HOME: '/h' },
      },
    });
  });

  test('leaves out a provider whose harness setting is not an absolute path', () => {
    expect(
      buildHubConfig([codex('anthropic-codex', { executable: 'codex' })], OXAP_HARNESSES, {}, {})
    ).toEqual({ value: { adapters: {}, environment: {} } });
  });

  test('puts a provider key only in the hub environment, never in the adapter entry', () => {
    const keyed: OxapHarness = {
      ...OXAP_HARNESSES['oxap-codex'],
      providers: ['anthropic-codex'],
      key: 'SYNTHETIC_API_KEY',
    };
    const harnesses = { 'oxap-codex': keyed };
    const same = buildHubConfig(
      [codex('anthropic-codex')],
      harnesses,
      {},
      {
        'anthropic-codex': 'sk-synthetic-a',
      }
    );
    expect(same).toMatchObject({
      value: {
        adapters: { 'anthropic-codex': { environment: ['SYNTHETIC_API_KEY'] } },
        environment: { SYNTHETIC_API_KEY: 'sk-synthetic-a' },
      },
    });
    expect(JSON.stringify((same as { value: { adapters: unknown } }).value.adapters)).not.toContain(
      'sk-synthetic-a'
    );
  });

  test('skips an unreadable provider record instead of failing every OXAP chat', () => {
    expect(
      buildHubConfig([{ providerId: 'anthropic-codex', configJson: '{' }], OXAP_HARNESSES, {}, {})
    ).toEqual({ value: { adapters: {}, environment: {} } });
  });
});
