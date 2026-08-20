import { describe, expect, test } from 'bun:test';
import { getAcpCommandIdentity, parseAcpCommand } from '../../../../src/lib/acp/acp-command';

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
