import { describe, expect, test } from 'bun:test';
import {
  buildAcpSafeEnv,
  getAcpCommandIdentity,
  getAcpCommandIdentityDigest,
  parseAcpCommand,
} from '../../../../src/lib/acp/acp-command';

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

describe('getAcpCommandIdentityDigest', () => {
  test('excludes secret-shaped argument values from the digest', () => {
    expect(getAcpCommandIdentityDigest('devin acp --token topsecret')).toBe(
      getAcpCommandIdentityDigest('devin acp --token othersecret')
    );
    expect(getAcpCommandIdentityDigest('agent --api-key=k1 --stdio')).toBe(
      getAcpCommandIdentityDigest('agent --api-key=k2 --stdio')
    );
    expect(getAcpCommandIdentityDigest('agent --password p1 run')).toBe(
      getAcpCommandIdentityDigest('agent --password p2 run')
    );
    expect(getAcpCommandIdentityDigest('devin acp --auth-token=a')).toBe(
      getAcpCommandIdentityDigest('devin acp --auth-token=b')
    );
  });

  test('still distinguishes commands that differ outside secret arguments', () => {
    expect(getAcpCommandIdentityDigest('devin acp --stdio')).not.toBe(
      getAcpCommandIdentityDigest('other-acp --stdio')
    );
    expect(getAcpCommandIdentityDigest('devin acp --model one')).not.toBe(
      getAcpCommandIdentityDigest('devin acp --model two')
    );
    expect(getAcpCommandIdentityDigest('devin acp --token a --stdio')).not.toBe(
      getAcpCommandIdentityDigest('devin acp --token a --verbose')
    );
    expect(getAcpCommandIdentityDigest('devin acp --max-tokens 4096')).not.toBe(
      getAcpCommandIdentityDigest('devin acp --max-tokens 8192')
    );
    expect(getAcpCommandIdentityDigest('devin acp --password-policy strict')).not.toBe(
      getAcpCommandIdentityDigest('devin acp --password-policy relaxed')
    );
  });
});
