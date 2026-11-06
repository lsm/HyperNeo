import { describe, expect, test } from 'bun:test';
import { parseCommand } from '../src/command';

describe('parseCommand', () => {
  test('preserves explicitly empty quoted arguments', () => {
    expect(parseCommand('agent --profile "" serve')).toEqual({
      command: 'agent',
      args: ['--profile', '', 'serve'],
    });
    expect(parseCommand("agent '' tail")).toEqual({
      command: 'agent',
      args: ['', 'tail'],
    });
  });

  test('rejects malformed commands', () => {
    expect(() => parseCommand("devin 'serve")).toThrow('Invalid command: unmatched quote');
    expect(() => parseCommand("'' serve")).toThrow('Invalid command: command is empty');
  });
});
