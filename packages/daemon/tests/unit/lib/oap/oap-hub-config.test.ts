import { describe, expect, test } from 'bun:test';
import { buildOapHubConfig } from '../../../../src/lib/oap/oap-hub-config';

describe('buildOapHubConfig', () => {
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
});
