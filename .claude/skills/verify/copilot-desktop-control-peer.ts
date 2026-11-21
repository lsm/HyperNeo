import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { Result, WorkDetail, WorkStarted, WorkDelivery } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

export async function startCopilotDesktopPeer(home: string, state: string) {
  const dir = join(home, '.copilot/run');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = randomUUID();
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: ({ req }) => new URL(req.url!, 'http://localhost').searchParams.get('token') === secret,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  writeFileSync(join(dir, 'ws.port'), `${address.port}\n${process.pid}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'ws.token'), `${secret}\n${process.pid}\n`, { mode: 0o600 });
  const db = new Database(state);
  db.exec('ALTER TABLE sessions ADD COLUMN model TEXT; ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT;');
  const ref = { adapter: 'copilot-cli', id: randomUUID() };
  const workspace = randomUUID();
  const project = randomUUID();
  const folder = join(home, '.copilot/session-state', ref.id);
  mkdirSync(folder, { recursive: true });
  const journal = (type: string, data: object) => appendFileSync(
    join(folder, 'events.jsonl'), JSON.stringify({ id: randomUUID(), type, data, timestamp: new Date().toISOString() }) + '\n'
  );
  const items: { id: string; message_id: string }[] = [];
  const messages: string[] = [];
  function observe(text: string, id: string) {
    journal('user.message', { messageId: id, interactionId: id, content: text });
    journal('assistant.message', { messageId: randomUUID(), interactionId: id, content: 'DESKTOP REPLY' });
    journal('session.idle', {});
  }
  let active = false;
  let kickoff = true;
  let path: string;
  let title: string;
  server.on('connection', (peer) => peer.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const reply = (type: string, fields: object = {}) => peer.send(JSON.stringify({ type, session_id: ref.id, request_id: message.request_id, ...fields }));
    messages.push(message.type);
    switch (message.type) {
      case 'create_project_from_path':
        path = message.path;
        db.prepare('INSERT OR IGNORE INTO projects VALUES (?, ?, ?)').run(project, 'Disposable project', path);
        return reply('project_created', { project: { id: project } });
      case 'create_folder_workspace':
        assert.equal(message.project_id, project);
        assert.equal(message.kickoff_prompt, undefined);
        title = message.name;
        return reply('workspace_created', { workspace: { id: workspace, displayPath: path } });
      case 'create_session':
        assert.equal(message.workspace_id, workspace);
        assert.equal(message.cwd, path);
        if (message.reasoning_effort === 'high') {
          db.prepare("INSERT INTO sessions VALUES (?, ?, ?, 0, 0, NULL, 'local', 0, ?, ?)").run(
            ref.id, title, new Date().toISOString(), message.model, message.reasoning_effort
          );
          db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, NULL, ?, NULL, NULL, 'local', 'folder')").run(
            workspace, ref.id, project, title
          );
        }
        return reply('session_created', { workspace_id: workspace, model: message.model, reasoning_effort: 'high' });
      case 'send_message': {
        assert.equal(message.session_id, ref.id);
        assert.equal(message.mode, 'enqueue');
        if (kickoff) {
          kickoff = false;
          active = true;
          db.prepare('UPDATE sessions SET is_running = 1 WHERE id = ?').run(ref.id);
          journal('user.message', { messageId: 'kickoff', interactionId: 'kickoff', content: message.prompt });
          return reply('session_message_sent', { message_id: 'kickoff' });
        }
        const message_id = randomUUID();
        if (active) items.push({ id: randomUUID(), message_id });
        else observe(message.prompt, message_id);
        return reply('session_message_sent', { message_id });
      }
      case 'get_session_queue':
        return reply('command_result', { data: { items } });
      case 'remove_session_queue_item': {
        const index = items.findIndex((item) => item.id === message.id);
        assert(index >= 0);
        items.splice(index, 1);
        return reply('command_result', { data: { outcome: { changed: true }, snapshot: { items } } });
      }
      case 'abort_session':
        active = false;
        journal('abort', { reason: 'user_initiated' });
        db.prepare('UPDATE sessions SET is_running = 0 WHERE id = ?').run(ref.id);
        return reply('session_event', { event: { type: 'abort' } });
      case 'execute_session_command': {
        assert.equal(active, false);
        assert.equal(message.command_name, 'compact');
        assert.equal(message.display_text, '/compact');
        const attempt = randomUUID();
        reply('session_command_complete', { outcome: 'queued' });
        reply('session_event', {
          event: { type: 'session.compaction_start', data: { trigger: 'manual', compactionAttemptId: attempt } },
        });
        reply('session_event', {
          event: { type: 'session.compaction_complete', data: { trigger: 'manual', compactionAttemptId: randomUUID(), success: true, outcome: 'applied' } },
        });
        return setTimeout(() => {
          const data = { trigger: 'manual', compactionAttemptId: attempt, success: true, outcome: 'applied' };
          journal('session.compaction_complete', data);
          reply('session_event', { event: { type: 'session.compaction_complete', data } });
        }, 250);
      }
      case 'rename_session':
        db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(message.title, ref.id);
        return reply('session_title_updated', { title: message.title });
      case 'archive_workspace':
        assert.equal(message.workspace_id, workspace);
        assert.equal(message.delete_worktree, false);
        db.prepare('UPDATE workspaces SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), workspace);
        return reply('workspace_archived', { workspace_id: workspace });
      default:
        return reply('error');
    }
  }));
  return {
    messages,
    ref,
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

export async function verifyCopilotDesktopControl(
  rpc: <T>(name: string, input: object) => Promise<T>,
  run: string,
  peer: Awaited<ReturnType<typeof startCopilotDesktopPeer>>,
  verifyCompaction: (work: WorkStarted) => Promise<void>
) {
  const folder = join(run, 'desktop-workspace');
  mkdirSync(folder);
  const request = {
    adapter: peer.ref.adapter,
    place: { machine: hostname(), folder: realpathSync(folder), name: 'Fixture' },
    title: 'Desktop work', model: 'desktop-model', effort: 'high', message: 'Initial prompt',
  };
  const bad = await rpc<Result<WorkStarted>>('work.start', { ...request, effort: 'low' });
  assert(!bad.ok && bad.reason === 'unreachable' && !bad.notSent, JSON.stringify(bad));
  assert(!peer.messages.includes('send_message'));
  const started = await rpc<Result<WorkStarted>>('work.start', request);
  assert(started.ok, JSON.stringify(started));
  const { ref } = started.value;
  assert.deepEqual(ref, peer.ref);
  assert.equal(started.value.model, request.model);
  assert.equal(started.value.effort, request.effort);
  assert.equal(started.value.receipt?.inputId, 'kickoff');
  const queued = await rpc<Result<WorkDelivery>>('work.queue', { ref, message: 'Withdraw this' });
  assert(queued.ok && queued.value.queuedSubmissionId && !queued.value.delivered, JSON.stringify(queued));
  const withdrawn = await rpc<Result<{ withdrawn: boolean }>>('work.withdraw', { ref, queuedSubmissionId: queued.value.queuedSubmissionId });
  assert(withdrawn.ok && withdrawn.value.withdrawn, JSON.stringify(withdrawn));
  const stopped = await rpc<Result<{ stopped: boolean }>>('work.stop', { ref });
  assert(stopped.ok && stopped.value.stopped, JSON.stringify(stopped));
  const sent = await rpc<Result<WorkDelivery>>('work.send', { ref, message: 'Follow up' });
  assert(sent.ok && sent.value.receipt, JSON.stringify(sent));
  const status = await rpc<Result<WorkDetail>>('work.status', { ref, receipt: sent.value.receipt });
  assert(status.ok && status.value.lastReply === 'DESKTOP REPLY', JSON.stringify(status));
  await verifyCompaction(started.value);
  const afterCompaction = await rpc<Result<WorkDetail>>('work.status', { ref, receipt: sent.value.receipt });
  assert(afterCompaction.ok && afterCompaction.value.lastReply === 'DESKTOP REPLY');
  const renamed = await rpc<Result<{ title: string }>>('work.rename', { ref, title: 'Renamed' });
  assert(renamed.ok && renamed.value.title === 'Renamed', JSON.stringify(renamed));
  const archived = await rpc<Result<{ archived: boolean }>>('neo.session.archive', { ref });
  assert(archived.ok && archived.value.archived, JSON.stringify(archived));
  const after = await rpc<Result<WorkDetail>>('work.status', { ref });
  assert(after.ok && after.value.archived && after.value.title === 'Renamed', JSON.stringify(after));
  console.log('PASS Desktop model, effort, kickoff, queue, withdrawal, stop, follow-up, compaction, rename and archive.');
}
