import { describe, expect, test } from 'bun:test';
import {
  buildAcpClientEnv,
  buildAcpSafeEnv,
  getAcpCommandIdentity,
  parseAcpCommand,
} from '../../../../src/lib/acp/acp-command';
import { _setStartupEnvBaselineForTesting } from '../../../../src/lib/spawn-env';

describe('buildAcpSafeEnv', () => {
  test('keeps only safe environment variables without unrelated secrets', () => {
    expect(
      buildAcpSafeEnv({
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

    expect(buildAcpSafeEnv(windowsEnv)).toEqual(windowsEnv);
  });

  test.skipIf(process.platform !== 'win32')(
    'resolves case-variant keys through the shared case-insensitive accessor',
    () => {
      expect(
        buildAcpSafeEnv({
          AppData: 'C:\\Users\\devin\\AppData\\Roaming',
          ComSpec: 'C:\\Windows\\system32\\cmd.exe',
        })
      ).toEqual({
        APPDATA: 'C:\\Users\\devin\\AppData\\Roaming',
        COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
      });
    }
  );
});

describe('buildAcpClientEnv', () => {
  test('layers selected credentials and proxy TLS inputs over the sanitized baseline', () => {
    const previousBaseline: Record<string, string | undefined> = { ...process.env };
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'ambient-secret';
    _setStartupEnvBaselineForTesting({
      ...previousBaseline,
      HYPERNEO_ACP_ENV_KEYS: 'MY_ACP_TOKEN, MISSING_KEY',
      MY_ACP_TOKEN: 'custom-token',
      HTTPS_PROXY: 'http://proxy.internal:8080',
      ANTHROPIC_API_KEY: 'ambient-secret',
    });
    try {
      const env = buildAcpClientEnv();

      expect(env.PATH).toBeDefined();
      expect(env.MY_ACP_TOKEN).toBe('custom-token');
      expect(env.HTTPS_PROXY).toBe('http://proxy.internal:8080');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.MISSING_KEY).toBeUndefined();
      expect(env.HYPERNEO_ACP_ENV_KEYS).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
      _setStartupEnvBaselineForTesting(previousBaseline);
    }
  });

  test('returns only the sanitized baseline when no credentials are selected', () => {
    const previousBaseline: Record<string, string | undefined> = { ...process.env };
    const withoutSelector = { ...previousBaseline };
    delete withoutSelector.HYPERNEO_ACP_ENV_KEYS;
    _setStartupEnvBaselineForTesting({ ...withoutSelector, MY_ACP_TOKEN: 'custom-token' });
    try {
      const env = buildAcpClientEnv();

      expect(env.MY_ACP_TOKEN).toBeUndefined();
      expect(env.HYPERNEO_ACP_ENV_KEYS).toBeUndefined();
    } finally {
      _setStartupEnvBaselineForTesting(previousBaseline);
    }
  });
});

describe('parseAcpCommand', () => {
  test('parses quoted paths, quoted arguments, and escapes', () => {
    expect(
      parseAcpCommand('"/Applications/Devin CLI/devin" acp "model one" escaped\\ arg')
    ).toEqual({
      command: '/Applications/Devin CLI/devin',
      args: ['acp', 'model one', 'escaped arg'],
    });
  });

  test('rejects empty commands', () => {
    expect(() => parseAcpCommand('   ')).toThrow('Invalid ACP command: command is empty');
  });

  test('rejects unmatched quotes', () => {
    expect(() => parseAcpCommand("devin 'acp")).toThrow('Invalid ACP command: unmatched quote');
    expect(() => parseAcpCommand('devin "acp')).toThrow('Invalid ACP command: unmatched quote');
  });
});

describe('getAcpCommandIdentity', () => {
  test('normalizes equivalent command identities', () => {
    expect(getAcpCommandIdentity('devin   acp "model one"')).toBe(
      getAcpCommandIdentity("devin acp 'model one'")
    );
  });
});
