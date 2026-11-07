import { describe, expect, test } from 'bun:test';
import { buildOapHubConfig } from '../../../../src/lib/oap/oap-hub-config';

describe('buildOapHubConfig', () => {
  test('sets the attended Codex approval and workspace sandbox posture', () => {
    const result = buildOapHubConfig({
      stateDirectory: '/synthetic/hub',
      codexExecutable: '/synthetic/bin/codex',
      codexHome: '/synthetic/codex-home',
    });
    expect(result.config.adapters.codex).toMatchObject({
      approval_policy: 'on-request',
      sandbox: 'workspace-write',
    });
  });

  test('generates only supported adapter fields, environment names, and isolated launch paths', () => {
    const result = buildOapHubConfig({
      stateDirectory: '/synthetic/hub',
      codexExecutable: '/synthetic/bin/codex',
      codexHome: '/synthetic/codex-home',
    });
    expect(result.config).toEqual({
      adapters: {
        codex: {
          type: 'codex',
          executable: '/synthetic/bin/codex',
          environment: ['CODEX_HOME'],
        },
      },
    });
    expect(result.args).toEqual([
      'serve',
      '--stdio',
      '--config',
      '/synthetic/hub/oap-serve.json',
      '--session-history',
      '/synthetic/hub/session-history.jsonl',
    ]);
    expect(result.environment).toEqual({
      HOME: '/synthetic/hub',
      CODEX_HOME: '/synthetic/codex-home',
    });
    expect(JSON.stringify(result.config)).not.toContain('/synthetic/codex-home');
  });
  test('rejects paths that could resolve against a shared working directory', () => {
    const valid = {
      stateDirectory: '/synthetic/hub',
      codexExecutable: '/synthetic/bin/codex',
      codexHome: '/synthetic/codex-home',
    };
    for (const key of ['stateDirectory', 'codexExecutable', 'codexHome'] as const) {
      expect(() => buildOapHubConfig({ ...valid, [key]: 'relative' })).toThrow('absolute');
    }
  });
});
