import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeAdapter } from '../../../../src/lib/drivers/claude-code-adapter';
import {
  createClaudeDesktopAdapter,
  readClaudeDesktopRecords,
  type ClaudeLiveSession,
  type ClaudeDesktopAdapterDeps,
} from '../../../../src/lib/drivers/claude-desktop-adapter';
import { claudeInboxFrame } from '../../../../src/lib/drivers/claude-inbox';
import { readClaudeReceiverMode } from '../../../../src/lib/drivers/claude-receiver-mode';

const context = { from: 'session:synthetic-origin', caller: { source: 'rpc' as const } };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-owner-delivery-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fixture(registered = false) {
  const id = crypto.randomUUID(),
    inputId = crypto.randomUUID();
  const cwd = join(dir, 'workspace'),
    records = join(dir, 'desktop'),
    projects = join(dir, 'projects');
  const transcriptDir = join(projects, cwd.replace(/[/.]/g, '-'));
  for (const path of [cwd, join(records, 'account/scope'), transcriptDir])
    mkdirSync(path, { recursive: true });
  const transcript = join(transcriptDir, `${id}.jsonl`);
  writeFileSync(transcript, '');
  const record = {
    sessionId: `local_${id}`,
    cliSessionId: id,
    title: 'Synthetic target',
    cwd,
    permissionMode: 'auto',
  };
  if (registered)
    writeFileSync(join(records, `account/scope/local_${id}.json`), JSON.stringify(record));
  let live: ClaudeLiveSession[] = [
    { sessionId: id, owner: registered ? 'desktop' : 'cli', pid: 1234, status: 'busy' },
  ];
  let command = `claude --resume ${id} --permission-mode auto`,
    receiverClass = 'prompting';
  const frames: string[] = [],
    held: string[] = [],
    spawns: string[][] = [];
  const listProcesses = async () => [{ pid: 1234, ppid: 1, elapsedSeconds: 2, command }];
  const sendInbox: NonNullable<ClaudeDesktopAdapterDeps['sendInbox']> = async (
    _,
    text,
    __,
    fromMode
  ) => {
    const frame = claudeInboxFrame(
      { sessionId: id, pid: 1234, socketPath: '/private/1234.sock', version: '2.1.302' },
      '/private/abc.sock',
      { messageId: inputId, inputId, text, fromMode }
    );
    frames.push(frame);
    if (frame.includes(`from-mode=\\"${receiverClass}\\"`))
      appendFileSync(
        transcript,
        JSON.stringify({
          type: 'user',
          uuid: inputId,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: text },
        }) + '\n'
      );
    else held.push(text);
    return {
      ok: true,
      value: { delivered: false, unconfirmed: true, receipt: { executionId: id, inputId } },
    };
  };
  const desktopDeps: ClaudeDesktopAdapterDeps = {
    sessionsDir: records,
    projectsDir: projects,
    machine: 'synthetic',
    homeDir: dir,
    liveSessions: async () => live,
    listProcesses,
    sendInbox,
    folderExists: () => true,
    makeFolder: () => {},
    newId: () => crypto.randomUUID(),
    now: Date.now,
    sleep: async () => {},
    searchChats: async () => [],
    spawn: (args) => {
      spawns.push(args);
      appendFileSync(
        transcript,
        JSON.stringify({
          type: 'user',
          uuid: inputId,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: args.at(-1) },
        }) + '\n'
      );
      return {
        stdout: new Response('').body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {},
      };
    },
  };
  const desktop = createClaudeDesktopAdapter(desktopDeps);
  const deps = {
    projectsDir: projects,
    machine: 'synthetic',
    searchChats: async () => [],
    desktopSessions: async () => new Set(registered ? [id] : []),
    desktopRecords: () => readClaudeDesktopRecords(records, new Map()),
    desktopSend: registered ? desktop.send : undefined,
    liveSessions: async () => live,
    listProcesses,
    sendInbox,
  };
  const code = createClaudeCodeAdapter(deps),
    ref = { adapter: 'claude-code', id };
  return {
    id,
    ref,
    code,
    desktop,
    transcript,
    frames,
    held,
    spawns,
    live: (value: ClaudeLiveSession[]) => {
      live = value;
    },
    mode: (value: string, receiver = value === 'bypassPermissions' ? 'bypass' : 'prompting') => {
      command = `claude --resume ${id} --permission-mode ${value}`;
      receiverClass = receiver;
    },
    emptyCommand: () => {
      command = 'claude';
    },
  };
}

describe('createClaudeCodeAdapter owner-aware delivery', () => {
  test.each(['default', 'auto', 'bypassPermissions'])(
    'plain CLI in %s receives without a permission hold',
    async (mode) => {
      const f = fixture();
      f.mode(mode);
      expect(await f.code.send!(f.ref, 'CLI delivery marker', context)).toMatchObject({ ok: true });
      expect(f.held).toEqual([]);
      expect(readFileSync(f.transcript, 'utf8')).toContain('CLI delivery marker');
      expect(f.spawns).toEqual([]);
    }
  );

  test('registered live Desktop UUID uses the existing confirmed Desktop path', async () => {
    const f = fixture(true);
    expect(await f.code.send!(f.ref, 'Desktop delivery marker', context)).toMatchObject({
      ok: true,
      value: { delivered: true },
    });
    expect(f.held).toEqual([]);
    expect(readFileSync(f.transcript, 'utf8')).toContain('Desktop delivery marker');
    expect(f.spawns).toEqual([]);
  });

  test('registered stopped Desktop UUID reuses its existing headless send', async () => {
    const f = fixture(true);
    f.live([]);
    expect(await f.code.send!(f.ref, 'Stopped Desktop marker', context)).toMatchObject({
      ok: true,
      value: { delivered: true },
    });
    expect(f.frames).toEqual([]);
    expect(f.spawns).toHaveLength(1);
    expect(f.spawns[0]).toContain('--resume');
    expect(readFileSync(f.transcript, 'utf8')).toContain('Stopped Desktop marker');
  });

  test('registered Desktop record with a CLI owner still matches the receiver class', async () => {
    const f = fixture(true);
    f.live([{ sessionId: f.id, owner: 'cli', pid: 1234, status: 'busy' }]);
    expect(
      await f.desktop.send!(
        { adapter: 'claude-desktop', id: `local_${f.id}` },
        'CLI owner marker',
        context
      )
    ).toMatchObject({ ok: true, value: { delivered: true } });
    expect(f.held).toEqual([]);
    expect(readFileSync(f.transcript, 'utf8')).toContain('CLI owner marker');
  });

  test('unknown CLI mode is a specific refusal without writing', async () => {
    const f = fixture();
    f.emptyCommand();
    expect(await f.code.send!(f.ref, 'Never guess mode', context)).toMatchObject({
      ok: false,
      reason: 'unsupported',
      detail: expect.stringMatching(/receiver.*mode.*unknown/i),
    });
    expect(f.frames).toEqual([]);
    expect(f.spawns).toEqual([]);
  });

  test.each(['zero', 'duplicate', 'unknown', 'wrong-id'])(
    '%s ownership cannot send or resume',
    async (kind) => {
      const f = fixture();
      if (kind === 'zero') f.live([]);
      if (kind === 'duplicate')
        f.live([
          { sessionId: f.id, owner: 'cli', pid: 1234, status: 'idle' },
          { sessionId: f.id, owner: 'cli', pid: 2345, status: 'idle' },
        ]);
      if (kind === 'unknown')
        f.live([{ sessionId: f.id, owner: 'unknown', pid: 1234, status: 'idle' }]);
      const ref = kind === 'wrong-id' ? { ...f.ref, id: `local_${f.id}` } : f.ref;
      expect(await f.code.send!(ref, 'Do not send', context)).toMatchObject({
        ok: false,
        reason: 'unreachable',
      });
      expect(f.frames).toEqual([]);
      expect(f.spawns).toEqual([]);
    }
  );
});

describe('readClaudeReceiverMode', () => {
  test.each(['cli', 'desktop'] as const)(
    'reads the verified %s receiver process',
    async (owner) => {
      const live = [{ sessionId: 'target', pid: 42, owner, status: 'busy' }];
      expect(
        await readClaudeReceiverMode(
          'target',
          async () => live,
          async () => [
            { pid: 42, ppid: 1, elapsedSeconds: 1, command: 'claude --permission-mode=auto' },
          ]
        )
      ).toBe('auto');
    }
  );
});
