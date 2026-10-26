import { describe, expect, test } from 'bun:test';
import { neoReadTools } from '../../../../src/lib/neo/session-config.ts';
import {
  extractBashScopePrefixes,
  sleepCommandVerdict,
} from '../../../../src/lib/agent/bash-scope.ts';

describe('neo wait admission', () => {
  test('the read preset admits bounded sleep waits with the canonical scoped rule', () => {
    const tools = neoReadTools();
    expect(tools.permissionMode).toBe('dontAsk');
    expect(tools.allowedTools).toContain('Bash(sleep:*)');
  });

  test('the preset carries the sleep scope entry; only the coordinator skips scoping', () => {
    expect(extractBashScopePrefixes(neoReadTools().allowedTools)).toEqual(['sleep']);
  });

  test('bounded waits pass the admission bound and longer or computed waits stay vetoed', () => {
    expect(sleepCommandVerdict('sleep 30')).toBe('allowed');
    expect(sleepCommandVerdict('sleep 0.5 && ls')).toBe('allowed');
    expect(sleepCommandVerdict('sleep 301')).toBe('denied');
    expect(sleepCommandVerdict('sleep 10 && sleep 290')).toBe('allowed');
    expect(sleepCommandVerdict('sleep 200 && sleep 200')).toBe('denied');
    expect(sleepCommandVerdict('/usr/bin/sleep 301')).toBe('denied');
    expect(sleepCommandVerdict('sleep $(cat seconds.txt)')).toBe('denied');
    expect(sleepCommandVerdict('echo done')).toBe('none');
  });

  test('indirect heads and non-sleep wait primitives stay vetoed', () => {
    expect(sleepCommandVerdict('$x 999')).toBe('denied');
    expect(sleepCommandVerdict('a=sl; b=eep; $a$b 999')).toBe('denied');
    expect(sleepCommandVerdict('`sleep 999`')).toBe('denied');
    expect(sleepCommandVerdict('python3 -c "import time; time.sleep(999)"')).toBe('denied');
    expect(sleepCommandVerdict('read -t 600')).toBe('denied');
    expect(sleepCommandVerdict('sleep 300 && read -t 300')).toBe('denied');
    expect(sleepCommandVerdict('FOO=time.sleep echo $FOO')).toBe('denied');
  });
});
