import { describe, expect, test } from 'bun:test';
import { getAcpCommandIdentity, parseAcpCommand } from '../src/acp/acp-command';

describe('parseAcpCommand', () => {
  test('normalizes quoting while preserving Windows path separators', () => {
    expect(parseAcpCommand('"C:\\Program Files\\Devin\\devin.exe" acp')).toEqual({
      command: 'C:\\Program Files\\Devin\\devin.exe',
      args: ['acp'],
    });
    expect(getAcpCommandIdentity('devin   acp "model one"')).toBe(
      getAcpCommandIdentity("devin acp 'model one'")
    );
  });

  test('rejects malformed commands', () => {
    expect(() => parseAcpCommand("devin 'acp")).toThrow('Invalid ACP command: unmatched quote');
  });
});
