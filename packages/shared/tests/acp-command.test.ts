import { describe, expect, test } from 'bun:test';
import { getAcpCommandIdentity, parseAcpCommand } from '../src/acp/acp-command';

describe('parseAcpCommand', () => {
  test('preserves explicitly empty quoted arguments', () => {
    expect(parseAcpCommand('agent --profile "" acp')).toEqual({
      command: 'agent',
      args: ['--profile', '', 'acp'],
    });
    expect(parseAcpCommand("agent '' tail")).toEqual({
      command: 'agent',
      args: ['', 'tail'],
    });
  });

  test('rejects malformed commands', () => {
    expect(() => parseAcpCommand("devin 'acp")).toThrow('Invalid ACP command: unmatched quote');
    expect(() => parseAcpCommand("'' acp")).toThrow('Invalid ACP command: command is empty');
  });
});

describe('getAcpCommandIdentity', () => {
  test('normalizes quoting variants to the same identity', () => {
    expect(getAcpCommandIdentity('devin   acp "model one"')).toBe(
      getAcpCommandIdentity("devin acp 'model one'")
    );
  });
});
