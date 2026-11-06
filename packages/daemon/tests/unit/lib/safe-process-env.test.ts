import { parseCommand } from '@hyperneo/shared/command';
import { describe, expect, test } from 'bun:test';
import { buildSafeProcessEnv } from '../../../src/lib/safe-process-env';

describe('buildSafeProcessEnv', () => {
  test('keeps worker location hints while stripping credentials from terminal children', () => {
    expect(
      buildSafeProcessEnv({
        HYPERNEO_WORKTREES: '/synthetic/data/worktrees',
        HYPERNEO_EVIDENCE: '/synthetic/data/work/evidence/worker',
        HYPERNEO_BUILDS: '/synthetic/data/work/builds/worker',
        GITHUB_TOKEN: 'synthetic-secret',
      })
    ).toEqual({
      HYPERNEO_WORKTREES: '/synthetic/data/worktrees',
      HYPERNEO_EVIDENCE: '/synthetic/data/work/evidence/worker',
      HYPERNEO_BUILDS: '/synthetic/data/work/builds/worker',
    });
  });

  test('keeps only safe environment variables without unrelated secrets', () => {
    expect(
      buildSafeProcessEnv({
        HOME: '/Users/devin',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        SHELL: '/bin/zsh',
        TMPDIR: '/var/folders/ab/',
        HTTPS_PROXY: 'http://proxy.internal:8080',
        NO_PROXY: 'localhost,.internal',
        https_proxy: 'http://legacy-secure-proxy.internal:8080',
        http_proxy: 'http://legacy-proxy.internal:8080',
        no_proxy: '127.0.0.1',
        NODE_USE_ENV_PROXY: '1',
        NODE_EXTRA_CA_CERTS: '/certs/internal.pem',
        GITHUB_TOKEN: 'secret',
        ANTHROPIC_API_KEY: 'secret',
      })
    ).toEqual({
      HOME: '/Users/devin',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      SHELL: '/bin/zsh',
      TMPDIR: '/var/folders/ab/',
      HTTPS_PROXY: 'http://proxy.internal:8080',
      NO_PROXY: 'localhost,.internal',
      https_proxy: 'http://legacy-secure-proxy.internal:8080',
      http_proxy: 'http://legacy-proxy.internal:8080',
      no_proxy: '127.0.0.1',
      NODE_USE_ENV_PROXY: '1',
      NODE_EXTRA_CA_CERTS: '/certs/internal.pem',
    });
  });

  test('keeps Windows runtime and profile variables required by native agents', () => {
    const windowsEnv = {
      USERPROFILE: 'C:\\Users\\devin',
      APPDATA: 'C:\\Users\\devin\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\devin\\AppData\\Local',
      TEMP: 'C:\\Users\\devin\\AppData\\Local\\Temp',
      TMP: 'C:\\Windows\\Temp',
      SystemRoot: 'C:\\Windows',
      SystemDrive: 'C:',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    };

    expect(buildSafeProcessEnv(windowsEnv)).toEqual(windowsEnv);
  });
});

describe('parseCommand', () => {
  test('parses quoted paths, quoted arguments, and escapes', () => {
    expect(parseCommand('"/Applications/Devin CLI/devin" serve "model one" escaped\\ arg')).toEqual(
      {
        command: '/Applications/Devin CLI/devin',
        args: ['serve', 'model one', 'escaped arg'],
      }
    );
  });

  test('rejects empty commands', () => {
    expect(() => parseCommand('   ')).toThrow('Invalid command: command is empty');
  });

  test('rejects unmatched quotes', () => {
    expect(() => parseCommand("devin 'serve")).toThrow('Invalid command: unmatched quote');
    expect(() => parseCommand('devin "serve')).toThrow('Invalid command: unmatched quote');
  });
});
