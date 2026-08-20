import { describe, expect, test } from 'bun:test';
import {
  buildAcpSafeEnv,
  getAcpCommandIdentity,
  parseAcpCommand,
} from '../../../../src/lib/acp/acp-command';

describe('buildAcpSafeEnv', () => {
  test('preserves required Windows profile variables without unrelated secrets', () => {
    expect(
      buildAcpSafeEnv({
        PATH: 'C:\\Windows\\System32',
        USERPROFILE: 'C:\\Users\\devin',
        APPDATA: 'C:\\Users\\devin\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\devin\\AppData\\Local',
        SYSTEMROOT: 'C:\\Windows',
        HTTPS_PROXY: 'http://proxy.internal:8080',
        NODE_USE_ENV_PROXY: '1',
        NODE_EXTRA_CA_CERTS: 'C:\\certs\\internal.pem',
        GITHUB_TOKEN: 'secret',
      })
    ).toEqual({
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\devin',
      APPDATA: 'C:\\Users\\devin\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\devin\\AppData\\Local',
      SYSTEMROOT: 'C:\\Windows',
      HTTPS_PROXY: 'http://proxy.internal:8080',
      NODE_USE_ENV_PROXY: '1',
      NODE_EXTRA_CA_CERTS: 'C:\\certs\\internal.pem',
    });
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

  test('preserves Windows path separators', () => {
    expect(parseAcpCommand('C:\\Tools\\devin.exe acp')).toEqual({
      command: 'C:\\Tools\\devin.exe',
      args: ['acp'],
    });
    expect(parseAcpCommand('"C:\\Program Files\\Devin\\devin.exe" acp')).toEqual({
      command: 'C:\\Program Files\\Devin\\devin.exe',
      args: ['acp'],
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
