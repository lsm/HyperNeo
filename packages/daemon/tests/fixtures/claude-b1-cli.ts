#!/usr/bin/env bun
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME!;
const run = join(home, '..');
const evidence = join(run, 'evidence');
const scope = join(
  home,
  'Library/Application Support/Claude/claude-code-sessions/synthetic/account'
);
const statePath = join(evidence, 'native-sessions.json');
type Session = {
  id: string;
  title: string;
  cwd: string;
  permissionMode: string;
  pid: number;
  status: string;
  waitingFor?: string;
};
const sessions: Session[] = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : [];
const flag = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const fault = () =>
  existsSync(join(evidence, 'fault')) ? readFileSync(join(evidence, 'fault'), 'utf8') : '';
const save = () => {
  writeFileSync(`${statePath}.${process.pid}`, JSON.stringify(sessions));
  renameSync(`${statePath}.${process.pid}`, statePath);
};
const recordPath = (s: Session) => join(scope, `local_${s.id}.json`);
const transcript = (s: Session) => {
  const dir = join(home, '.claude/projects', s.cwd.replace(/[/.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  return join(dir, `${s.id}.jsonl`);
};
const append = (s: Session, entry: Record<string, unknown>) =>
  appendFileSync(
    transcript(s),
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`
  );
const log = (entry: Record<string, unknown>) =>
  appendFileSync(join(evidence, 'native-events.jsonl'), `${JSON.stringify(entry)}\n`);

if (process.argv.includes('agents')) {
  process.stdout.write(
    JSON.stringify(
      sessions
        .filter((s) => s.pid)
        .map((s) => ({
          sessionId: s.id,
          pid: s.pid,
          cwd: s.cwd,
          status: s.status,
          name: s.title,
          waitingFor: s.waitingFor,
        }))
    )
  );
} else if (process.argv.includes('--synthetic-desktop-import')) {
  if (fault() === 'hanging-import') {
    process.on('SIGHUP', () => {});
    writeFileSync(join(evidence, 'hanging-import.pid'), String(process.pid));
    log({ kind: 'hanging-import' });
    await new Promise((resolve) => setTimeout(resolve, 300000));
    process.exit(1);
  }
  const s = sessions.find((s) => s.id === flag('--resume'))!;
  if (fault() === 'missing-import') process.exit(1);
  s.permissionMode = s.title === 'rc-toggle' ? 'bypassPermissions' : 'acceptEdits';
  const blockedPath = join(evidence, 'blocked-imports.json');
  const blocked: string[] = existsSync(blockedPath)
    ? JSON.parse(readFileSync(blockedPath, 'utf8'))
    : [];
  const staysDead =
    blocked.includes(s.id) || (fault() === 'dead-helpers' && s.title === 'desktop-wake');
  if (!staysDead) s.pid ||= 9000 + sessions.indexOf(s);
  mkdirSync(scope, { recursive: true });
  writeFileSync(
    recordPath(s),
    JSON.stringify({
      sessionId: `local_${s.id}`,
      cliSessionId: s.id,
      title: s.title,
      cwd: s.cwd,
      lastActivityAt: Date.now(),
      permissionMode: s.permissionMode,
    })
  );
  const registrations = join(home, '.claude/sessions');
  mkdirSync(registrations, { recursive: true });
  writeFileSync(
    join(registrations, `${s.pid}.json`),
    JSON.stringify({
      sessionId: s.id,
      pid: s.pid,
      procStart: 1,
      entrypoint: 'claude-desktop',
      version: '2.1.302',
      peerProtocol: 1,
      peerFeatures: ['notify_idle'],
      messagingSocketPath: join(run, `${s.pid}.sock`),
    })
  );
  save();
  log({ kind: 'import', id: s.id, mode: s.permissionMode });
} else if (process.argv.includes('--session-id')) {
  if (fault() === 'slow-helper' && flag('-n') === 'desktop-wake')
    await new Promise((resolve) => setTimeout(resolve, 250));
  const s: Session = {
    id: flag('--session-id'),
    title: flag('-n'),
    cwd: process.cwd(),
    permissionMode: flag('--permission-mode'),
    pid: 0,
    status: 'idle',
  };
  sessions.push(s);
  save();
  const text = process.argv.at(-1)!;
  append(s, {
    type: 'user',
    uuid: crypto.randomUUID(),
    cwd: s.cwd,
    entrypoint: 'sdk-cli',
    permissionMode: s.permissionMode,
    message: { content: text },
  });
  append(s, {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    message: { content: [{ type: 'text', text: 'ready' }], stop_reason: 'end_turn' },
  });
  log({ kind: 'prepare', id: s.id, text, args: process.argv.slice(2) });
} else if (process.argv.includes('HyperNeo relay')) {
  const prompt = process.argv.at(-1)!;
  const named = /to the session named ("(?:[^"\\]|\\.)*")/.exec(prompt)!;
  const name: string = JSON.parse(named[1]);
  const helper = sessions.find((s) => s.title === name && s.pid)!;
  const text = prompt.split('<message>\n')[1].split('\n\n(Relayed from HyperNeo')[0];
  log({ kind: 'relay', helper: helper.id, mode: flag('--permission-mode'), text });
  append(helper, {
    type: 'user',
    uuid: crypto.randomUUID(),
    message: {
      content: `<cross-session-message from="uds:/synthetic.sock">\n${text}\n</cross-session-message>`,
    },
  });
  if (helper.title === 'rc-toggle') {
    const id = /local_([\da-f-]+)/.exec(text)![1];
    const target = sessions.find((s) => s.id === id)!;
    const record = JSON.parse(readFileSync(recordPath(target), 'utf8'));
    writeFileSync(
      recordPath(target),
      JSON.stringify({
        ...record,
        remoteControlUserEnabled: true,
        bridgeSessionIds: ['session_SyntheticNativeB1'],
      })
    );
    log({ kind: 'rc-request', target: id, mode: helper.permissionMode });
  } else {
    const request: { session_id: string; message: string } = JSON.parse(
      text.split('<native_forward_request>\n')[1].split('\n</native_forward_request>')[0]
    );
    const target = sessions.find((s) => `local_${s.id}` === request.session_id)!;
    if (fault() === 'refused') {
      process.stderr.write('Native send_message refused');
      process.exit(1);
    }
    log({ kind: 'native-send', helper: helper.id, target: target.id, message: request.message });
    if (fault() === 'queued') {
      target.status = 'running';
      log({
        kind: 'native-queued',
        helper: helper.id,
        target: target.id,
        message: request.message,
      });
      save();
      process.stdout.write('Native message queued while target is mid-turn');
      process.exit(0);
    }
    append(target, {
      type: 'user',
      uuid: crypto.randomUUID(),
      message: {
        content: `<system-reminder>Native Desktop context</system-reminder>\n<cross-session-message from="local_${helper.id}" name="desktop-wake">\n${request.message}\n</cross-session-message>`,
      },
    });
    if (fault() === 'waiting') {
      target.status = 'waiting';
      target.waitingFor = 'permission prompt';
    } else {
      target.status = 'idle';
      delete target.waitingFor;
      append(target, {
        type: 'assistant',
        uuid: crypto.randomUUID(),
        message: {
          content: [{ type: 'text', text: `Completed: ${request.message}` }],
          stop_reason: 'end_turn',
        },
      });
    }
    save();
  }
  process.stdout.write('Synthetic native delivery observed');
} else {
  log({ kind: 'forbidden-cli', args: process.argv.slice(2) });
  process.exit(1);
}
