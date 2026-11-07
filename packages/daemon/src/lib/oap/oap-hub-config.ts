import { isAbsolute, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';

export interface OapHubConfigInput {
  stateDirectory: string;
  codexExecutable: string;
  codexHome: string;
}

export interface OapHubConfig {
  config: {
    adapters: {
      codex: {
        type: 'codex';
        executable: string;
        environment: ['CODEX_HOME'];
      };
    };
  };
  args: string[];
  environment: { HOME: string; CODEX_HOME: string };
}

function validatePaths(input: OapHubConfigInput): OapHubConfigInput {
  if (
    !isAbsolute(input.stateDirectory) ||
    !isAbsolute(input.codexExecutable) ||
    !isAbsolute(input.codexHome)
  ) {
    throw new Error('OAP hub paths must be absolute');
  }
  return input;
}

function makeHubConfig(input: OapHubConfigInput): OapHubConfig {
  return {
    config: {
      adapters: {
        codex: {
          type: 'codex',
          executable: input.codexExecutable,
          environment: ['CODEX_HOME'],
        },
      },
    },
    args: [
      'serve',
      '--stdio',
      '--config',
      join(input.stateDirectory, 'oap-serve.json'),
      '--session-history',
      join(input.stateDirectory, 'session-history.jsonl'),
    ],
    environment: { HOME: input.stateDirectory, CODEX_HOME: input.codexHome },
  };
}

export const buildOapHubConfig = (superpipe({})('build-oap-hub-config') as PipelineAPI)
  .input('input')
  .pipe(validatePaths, 'input', 'paths')
  .pipe(makeHubConfig, 'paths', 'result')
  .end('result') as (input: OapHubConfigInput) => OapHubConfig;
