import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeDesktopAdapter } from '../../../../src/lib/drivers/claude-desktop-adapter';

const runs: string[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) rmSync(run, { recursive: true, force: true });
});

test.each([
  ['auto', '--permission-mode=bypassPermissions', 'bypassPermissions', false],
  ['auto', '--permission-mode bypassPermissions', 'bypassPermissions', false],
  ['auto', '--dangerously-skip-permissions', 'bypassPermissions', false],
  ['bypassPermissions', '--permission-mode auto', 'auto', false],
  ['auto', '--permission-mode bypassPermissions', 'bypassPermissions', true],
])(
  'retries a held input once using live %s receiver mode (%s)',
  async (stored, flag, actual, refuse) => {
    const run = mkdtempSync(join(tmpdir(), 'desktop-held-'));
    runs.push(run);
    const sessionsDir = join(run, 'records');
    const cwd = join(run, 'workspace');
    const folder = join(run, 'projects', cwd.replace(/[/.]/g, '-'));
    mkdirSync(join(sessionsDir, 'account/scope'), { recursive: true });
    mkdirSync(folder, { recursive: true });
    const transcript = join(folder, 'receiver.jsonl');
    writeFileSync(transcript, '');
    writeFileSync(
      join(sessionsDir, 'account/scope/local_receiver.json'),
      JSON.stringify({
        sessionId: 'local_receiver',
        cliSessionId: 'receiver',
        cwd,
        title: 'Synthetic receiver',
        permissionMode: stored,
      })
    );
    const attempts: string[] = [];
    let reads = 0;
    let clock = 0;
    const adapter = createClaudeDesktopAdapter({
      sessionsDir,
      projectsDir: join(run, 'projects'),
      homeDir: run,
      machine: 'test',
      liveSessions: async () => [
        {
          sessionId: 'receiver',
          pid: 4321,
          owner: 'desktop',
          status: 'idle',
          name: 'Synthetic receiver',
        },
      ],
      listProcesses: async () => {
        reads++;
        return [
          { pid: 4322, ppid: 1, elapsedSeconds: 20, command: 'claude --permission-mode plan' },
          { pid: 4321, ppid: 1, elapsedSeconds: 20, command: `claude --resume receiver ${flag}` },
        ];
      },
      sendInbox: async (_session, _message, _context, fromMode) => {
        attempts.push(`direct:${fromMode}`);
        appendFileSync(
          transcript,
          JSON.stringify({
            type: 'system',
            content: 'Peer message held: sender permission mode differs',
          }) + '\n'
        );
        return {
          ok: true,
          value: {
            delivered: false,
            unconfirmed: true,
            receipt: { executionId: 'receiver', inputId: 'held-input' },
          },
        };
      },
      spawn: (args) => {
        const mode = args[args.indexOf('--permission-mode') + 1];
        attempts.push(`relay:${mode}`);
        if (mode === actual && !refuse)
          appendFileSync(
            transcript,
            JSON.stringify({
              type: 'user',
              uuid: 'delivered-input',
              message: {
                content:
                  '<cross-session-message from="relay">\nSynthetic marker\n</cross-session-message>',
              },
            }) + '\n'
          );
        return {
          stdout: new Response('').body,
          stderr: new Response(mode === actual && !refuse ? '' : 'held: permission mode differs')
            .body,
          exited: Promise.resolve(mode === actual && !refuse ? 0 : 1),
          exitCode: mode === actual && !refuse ? 0 : 1,
          kill: () => {},
        };
      },
      folderExists: () => true,
      makeFolder: () => {},
      gitCheckout: async () => null,
      newId: () => 'unused',
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    const result = await adapter.send!(
      { adapter: 'claude-desktop', id: 'local_receiver' },
      'Synthetic marker',
      { from: 'session:origin', caller: { source: 'internal' } }
    );
    expect(result).toMatchObject(
      refuse
        ? {
            ok: false,
            reason: 'not_delivered',
            detail: expect.stringContaining('receiver mode: bypassPermissions'),
          }
        : {
            ok: true,
            value: { delivered: true, receipt: { inputId: 'delivered-input' } },
          }
    );
    expect(attempts).toEqual([
      `direct:${stored === 'bypassPermissions' ? 'bypass' : 'prompting'}`,
      `relay:${actual}`,
    ]);
    expect(reads).toBe(1);
  }
);
