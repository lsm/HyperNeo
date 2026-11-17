import { describe, expect, it } from 'vitest';
import { isOxapHarness, OXAP_HARNESSES } from '@hyperneo/shared/types/oxap-harnesses';
import {
  codexSessionRefusal,
  decideSwitch,
  effectiveOxapConfig,
  engineForProvider,
  sdkFallbackProviders,
  selectSessionEngine,
  thinkingRefusal,
} from '../../../../src/lib/agent/session-engine';

describe('selectSessionEngine', () => {
  it('selects the SDK when harness is absent', () => {
    expect(selectSessionEngine(undefined)).toBe('sdk');
  });

  it('selects supported harnesses and rejects unknown values', () => {
    expect(selectSessionEngine('sdk')).toBe('sdk');
    expect(selectSessionEngine('oxap-codex')).toBe('oxap-codex');
    expect(() => selectSessionEngine('unknown')).toThrow();
    expect(() => selectSessionEngine('codex')).toThrow();
  });
});

describe('isOxapHarness', () => {
  it('is true for every OXAP_HARNESSES id and false for the SDK and unknown values', () => {
    for (const id of Object.keys(OXAP_HARNESSES)) expect(isOxapHarness(id)).toBe(true);
    expect(isOxapHarness('oxap-codex')).toBe(true);
    for (const other of ['sdk', 'codex', undefined, 'toString']) {
      expect(isOxapHarness(other)).toBe(false);
    }
  });
});

describe('codexSessionRefusal', () => {
  it('refuses Neo root sessions while allowing an ordinary unattended-free session', () => {
    const config = { harness: 'oxap-codex' } as const;
    expect(codexSessionRefusal(config, false, true)).toMatch(/Neo/);
    expect(codexSessionRefusal(config, false, false)).toBeUndefined();
  });

  it('refuses a plan permission mode and accepts default or strictMcpConfig alone', () => {
    expect(codexSessionRefusal({ permissionMode: 'plan' }, false, false)).toMatch(
      /restriction is not supported/
    );
    expect(codexSessionRefusal({ permissionMode: 'default' }, false, false)).toBeUndefined();
    expect(codexSessionRefusal({ strictMcpConfig: true }, false, false)).toBeUndefined();
  });
});

describe('engineForProvider', () => {
  const record = (config: Record<string, unknown> | undefined) => () =>
    config === undefined ? null : { configJson: JSON.stringify(config) };

  it('reads the harness a provider record names and defaults to Claude Code', () => {
    expect(engineForProvider('anthropic-codex', record({ harness: 'oxap-codex' }))).toBe(
      'oxap-codex'
    );
    expect(engineForProvider('anthropic-codex', record({}))).toBe('sdk');
    expect(engineForProvider('anthropic-codex', record(undefined))).toBe('sdk');
  });

  it('never gives a harness to a provider its row does not list', () => {
    let read = false;
    const spy = () => {
      read = true;
      return { configJson: JSON.stringify({ harness: 'oxap-codex' }) };
    };
    expect(engineForProvider('anthropic', spy)).toBe('sdk');
    expect(read).toBe(false);
  });

  it('refuses a provider record that names an unknown harness', () => {
    expect(() => engineForProvider('anthropic-codex', record({ harness: 'codex' }))).toThrow(
      /unsupported harness/
    );
  });

  it('reads a null config as Claude Code and refuses an unreadable one clearly', () => {
    expect(engineForProvider('anthropic-codex', () => ({ configJson: 'null' }))).toBe('sdk');
    expect(() => engineForProvider('anthropic-codex', () => ({ configJson: '' }))).toThrow(
      /Provider anthropic-codex has an unreadable config/
    );
  });
});

describe('sdkFallbackProviders', () => {
  it('drops only the candidate whose provider record is unreadable or OXAP', () => {
    const records: Record<string, string> = {
      'anthropic-codex': '',
      glm: '{"harness":"oxap-codex"}',
    };
    const providers = [{ id: 'anthropic' }, { id: 'anthropic-codex' }, { id: 'glm' }];
    expect(
      sdkFallbackProviders(providers, (id) =>
        records[id] === undefined ? null : { configJson: records[id] }
      ).map((provider) => provider.id)
    ).toEqual(['anthropic', 'glm']);
    expect(
      sdkFallbackProviders(providers, (id) =>
        id === 'anthropic-codex' ? { configJson: '{"harness":"oxap-codex"}' } : null
      ).map((provider) => provider.id)
    ).toEqual(['anthropic', 'glm']);
  });
});

describe('effectiveOxapConfig', () => {
  const global = { permissionMode: 'plan', sandbox: { enabled: true }, coordinatorMode: true };

  it('fills permission, sandbox and coordinator mode from global settings when the chat has none', () => {
    expect(effectiveOxapConfig({ model: 'm' }, global as never)).toEqual({
      model: 'm',
      permissionMode: 'plan',
      sandbox: { enabled: true },
      coordinatorMode: true,
    });
    expect(
      effectiveOxapConfig(
        { permissionMode: 'default', sandbox: { enabled: false }, coordinatorMode: false },
        global as never
      )
    ).toEqual({ permissionMode: 'default', sandbox: { enabled: false }, coordinatorMode: false });
  });

  it('makes a global plan mode or coordinator mode a refusal', () => {
    expect(codexSessionRefusal(effectiveOxapConfig({}, global as never), false, false)).toMatch(
      /restriction is not supported/
    );
    expect(codexSessionRefusal({ coordinatorMode: true }, false, false)).toMatch(
      /restriction is not supported/
    );
    expect(codexSessionRefusal({ coordinatorMode: false }, false, false)).toBeUndefined();
  });
});

describe('decideSwitch', () => {
  it('lets an OXAP chat keep its provider and refuses every provider change', () => {
    const oxap = { harness: 'oxap-codex', provider: 'anthropic-codex' } as const;
    expect(decideSwitch(oxap, 'anthropic-codex', 'oxap-codex')).toBe(true);
    expect(decideSwitch(oxap, 'anthropic', 'sdk')).toMatch(/cannot change its provider/);
    expect(decideSwitch(oxap, 'other-codex', 'oxap-codex')).toMatch(/cannot change its provider/);
  });

  it('refuses moving a Claude Code chat to an OXAP provider', () => {
    const sdk = { provider: 'anthropic' } as const;
    expect(decideSwitch(sdk, 'anthropic-codex', 'oxap-codex')).toMatch(/cannot move to/);
    expect(decideSwitch(sdk, 'glm', 'sdk')).toBe(true);
  });
});

describe('thinkingRefusal', () => {
  it('refuses a thinking level only for an OXAP row without thinking', () => {
    expect(thinkingRefusal('oxap-codex', 'think16k')).toMatch(/does not take a thinking level/);
    expect(thinkingRefusal('oxap-codex', undefined)).toBeUndefined();
    expect(thinkingRefusal(undefined, 'think16k')).toBeUndefined();
  });
});
