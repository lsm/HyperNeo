import { describe, test, expect } from 'bun:test';
import { parseDaemonArgs, getDaemonHelpText } from '../src/daemon-cli';

describe('parseDaemonArgs', () => {
  test('returns empty options for no arguments', () => {
    const result = parseDaemonArgs([]);
    expect(result.options).toEqual({});
    expect(result.error).toBeUndefined();
  });

  test('parses --help flag', () => {
    const result = parseDaemonArgs(['--help']);
    expect(result.options.help).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('parses -h flag', () => {
    const result = parseDaemonArgs(['-h']);
    expect(result.options.help).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('parses --version flag', () => {
    const result = parseDaemonArgs(['--version']);
    expect(result.options.version).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('parses -V flag', () => {
    const result = parseDaemonArgs(['-V']);
    expect(result.options.version).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('parses --port with valid value', () => {
    const result = parseDaemonArgs(['--port', '9283']);
    expect(result.options.port).toBe(9283);
    expect(result.error).toBeUndefined();
  });

  test('parses -p with valid value', () => {
    const result = parseDaemonArgs(['-p', '8080']);
    expect(result.options.port).toBe(8080);
    expect(result.error).toBeUndefined();
  });

  test('returns error for invalid port value', () => {
    const result = parseDaemonArgs(['--port', 'invalid']);
    expect(result.error).toBe('Invalid port value: invalid');
  });

  test('parses --host with value', () => {
    const result = parseDaemonArgs(['--host', '127.0.0.1']);
    expect(result.options.host).toBe('127.0.0.1');
    expect(result.error).toBeUndefined();
  });

  test('parses --db-path with value', () => {
    const result = parseDaemonArgs(['--db-path', '/tmp/daemon.db']);
    expect(result.options.dbPath).toBe('/tmp/daemon.db');
    expect(result.error).toBeUndefined();
  });

  test('parses --data-dir with value', () => {
    const result = parseDaemonArgs(['--data-dir', '/var/lib/hyperneod']);
    expect(result.options.dataDir).toBe('/var/lib/hyperneod');
    expect(result.error).toBeUndefined();
  });

  test('returns error for --data-dir without a value', () => {
    const result = parseDaemonArgs(['--data-dir']);
    expect(result.error).toBe('--data-dir requires a directory');
  });

  test('parses --workspace with value', () => {
    const result = parseDaemonArgs(['--workspace', '/tmp/workspace']);
    expect(result.options.workspaceRoot).toBe('/tmp/workspace');
    expect(result.error).toBeUndefined();
  });

  test('returns error for unknown option and requests help output', () => {
    const result = parseDaemonArgs(['--unknown']);
    expect(result.options.help).toBe(true);
    expect(result.error).toBe('Unknown option: --unknown');
  });

  test('parses combined flags and options', () => {
    const result = parseDaemonArgs([
      '--port',
      '9400',
      '--host',
      'localhost',
      '--db-path',
      '/tmp/db.sqlite',
      '--data-dir',
      '/tmp/hyperneod',
    ]);
    expect(result.options).toEqual({
      port: 9400,
      host: 'localhost',
      dbPath: '/tmp/db.sqlite',
      dataDir: '/tmp/hyperneod',
    });
    expect(result.error).toBeUndefined();
  });
});

describe('getDaemonHelpText', () => {
  test('documents every accepted flag', () => {
    const help = getDaemonHelpText();
    expect(help).toContain('--port');
    expect(help).toContain('--host');
    expect(help).toContain('--db-path');
    expect(help).toContain('--data-dir');
    expect(help).toContain('--workspace');
    expect(help).toContain('--version');
    expect(help).toContain('--help');
    expect(help).toContain('hyperneod');
  });
});
