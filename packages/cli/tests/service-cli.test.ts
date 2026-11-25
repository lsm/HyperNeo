import { describe, expect, test } from 'bun:test';
import type { SpawnFn } from '@hyperneo/daemon/lib/runtime-spawn';
import {
  SERVICE_LABEL,
  planService,
  runService,
  servicePlist,
  serviceProgram,
} from '../src/service-cli';

const PLIST = `/Users/owner/Library/LaunchAgents/${SERVICE_LABEL}.plist`;

function harness(results: Record<string, { code: number; text?: string }> = {}) {
  const calls: string[][] = [];
  const written: Record<string, string> = {};
  const removed: string[] = [];
  const printed: string[] = [];
  const spawn: SpawnFn = (args) => {
    calls.push(args);
    const result = results[args[1] ?? ''] ?? { code: 0 };
    return {
      exited: Promise.resolve(result.code),
      exitCode: result.code,
      stdout: new Response(result.text ?? '').body,
      stderr: new Response('').body,
      kill: () => {},
    };
  };
  const deps = {
    spawn,
    home: '/Users/owner',
    uid: 501,
    execPath: '/opt/homebrew/bin/bun',
    moduleUrl: 'file:///src/hyperneo/packages/cli/src/service-cli.ts',
    mainPath: '/src/hyperneo/packages/cli/main.ts',
    path: '/opt/homebrew/bin:/usr/bin',
    print: (text: string) => printed.push(text),
    write: async (path: string, text: string) => {
      written[path] = text;
    },
    remove: async (path: string) => {
      removed.push(path);
    },
  };
  return { deps, calls, written, removed, printed };
}

describe('planService', () => {
  test('reads install flags, uninstall and status', () => {
    expect(planService(['install'])).toEqual({ action: 'install' });
    expect(planService(['install', '--host', '0.0.0.0', '--port', '9283'])).toEqual({
      action: 'install',
      host: '0.0.0.0',
      port: '9283',
    });
    expect(planService(['uninstall'])).toEqual({ action: 'uninstall' });
    expect(planService(['status'])).toEqual({ action: 'status' });
  });

  test('rejects unknown actions, bad ports and dangling flags', () => {
    for (const args of [
      [],
      ['start'],
      ['install', '--port', '70000'],
      ['install', '--port', 'abc'],
      ['install', '--host'],
      ['install', '--host', '--port'],
      ['install', '--expose', 'yes'],
      ['status', 'now'],
    ])
      expect('reason' in planService(args)).toBe(true);
  });
});

describe('serviceProgram', () => {
  test('runs the compiled binary itself', () => {
    expect(
      serviceProgram('/usr/local/lib/hyperneo', 'file:///$bunfs/root/hyperneo', '/x/main.ts')
    ).toEqual({ program: ['/usr/local/lib/hyperneo'], env: {} });
  });

  test('runs a source checkout through bun in production mode', () => {
    expect(
      serviceProgram('/opt/homebrew/bin/bun', 'file:///src/cli/service-cli.ts', '/src/main.ts')
    ).toEqual({
      program: ['/opt/homebrew/bin/bun', '/src/main.ts'],
      env: { NODE_ENV: 'production' },
    });
  });
});

describe('servicePlist', () => {
  test('keeps the daemon alive and escapes XML', () => {
    const plist = servicePlist({
      program: ['/a&b/bun', 'main.ts'],
      env: { PATH: '/x<y' },
      home: '/Users/owner',
      workingDirectory: '/src',
    });
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain('<string>/a&amp;b/bun</string>');
    expect(plist).toContain('<key>PATH</key>\n    <string>/x&lt;y</string>');
    expect(plist).toContain('<key>HOME</key>\n    <string>/Users/owner</string>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('/Users/owner/.hyperneo/logs/service.err.log');
  });
});

describe('runService', () => {
  test('install writes the plist and bootstraps it after booting out the old one', async () => {
    const h = harness();
    expect(await runService(['install', '--host', '0.0.0.0'], h.deps)).toBe(0);
    expect(h.calls).toEqual([
      ['/bin/launchctl', 'bootout', `gui/501/${SERVICE_LABEL}`],
      ['/bin/launchctl', 'bootstrap', 'gui/501', PLIST],
    ]);
    const plist = h.written[PLIST] ?? '';
    expect(plist).toContain(
      '<string>/opt/homebrew/bin/bun</string>\n    <string>/src/hyperneo/packages/cli/main.ts</string>\n    <string>--host</string>\n    <string>0.0.0.0</string>'
    );
    expect(plist).toContain('<key>NODE_ENV</key>\n    <string>production</string>');
    expect(plist).toContain('<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin</string>');
    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/src/hyperneo</string>');
  });

  test('install reports a failed bootstrap', async () => {
    const h = harness({ bootstrap: { code: 5, text: 'Input/output error' } });
    expect(await runService(['install'], h.deps)).toBe(1);
    expect(h.printed.join('\n')).toContain('Input/output error');
  });

  test('uninstall boots out and removes the plist', async () => {
    const h = harness();
    expect(await runService(['uninstall'], h.deps)).toBe(0);
    expect(h.calls).toEqual([['/bin/launchctl', 'bootout', `gui/501/${SERVICE_LABEL}`]]);
    expect(h.removed).toEqual([PLIST]);
  });

  test('status prints the pid or not installed', async () => {
    const running = harness({ print: { code: 0, text: 'state = running\n\tpid = 4242\n' } });
    expect(await runService(['status'], running.deps)).toBe(0);
    expect(running.printed).toEqual(['loaded, pid 4242']);
    const missing = harness({ print: { code: 113 } });
    expect(await runService(['status'], missing.deps)).toBe(1);
    expect(missing.printed).toEqual(['not installed']);
  });

  test('bad arguments print usage without touching launchd', async () => {
    const h = harness();
    expect(await runService(['restart'], h.deps)).toBe(1);
    expect(h.calls).toEqual([]);
  });
});
