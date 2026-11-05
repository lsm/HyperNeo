import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

const run = process.argv[2];
const port = process.env.VERIFY_PORT;
assert(run && port && port !== '8399');
type Receipt = { kind: string; messageId: string; mailboxId: string; reason?: string };
const observed: Receipt[] = [];
async function rpc(method: string, data: unknown, drop = false): Promise<unknown> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    const id = crypto.randomUUID();
    const reply = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RPC deadline exceeded')), 15000);
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.requestId !== id && message.id !== id) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.data);
      };
      socket.send(
        JSON.stringify({
          id,
          type: 'REQ',
          sessionId: 'global',
          method,
          data,
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );
    });
    if (method === 'operation.invoke') observed.push(reply as Receipt);
    if (drop) throw new Error('Simulated lost response after daemon acceptance');
    return reply;
  } finally {
    socket.close();
  }
}
const workspace = join(run, 'workspace');
mkdirSync(workspace, { recursive: true });
const created = (await rpc('session.create', {
  workspacePath: workspace,
  worktreeMode: 'direct',
  title: 'Session voice retry verification',
})) as { sessionId: string };
assert(created.sessionId);
const recordId = crypto.randomUUID();
const input = {
  sessionId: created.sessionId,
  idempotencyKey: `voice:${recordId}`,
  message: {
    type: 'user',
    inputKind: 'human',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: 'Typed prefix\nFinal voice words\n\nSession voice retry receipt',
    },
  },
};
await assert.rejects(
  rpc('operation.invoke', { name: 'message.send', input }, true),
  /Simulated lost response/
);
const replay = (await rpc('operation.invoke', { name: 'message.send', input })) as Receipt;
const another = (await rpc('operation.invoke', { name: 'message.send', input })) as Receipt;
assert.equal(replay.kind, 'accepted');
assert.equal(observed[0].kind, 'accepted');
assert.equal(replay.messageId, observed[0].messageId);
assert.equal(replay.mailboxId, observed[0].mailboxId);
assert.equal(another.messageId, replay.messageId);
const conflicting = (await rpc('operation.invoke', {
  name: 'message.send',
  input: {
    ...input,
    message: { ...input.message, message: { role: 'user', content: 'Different words' } },
  },
})) as Receipt;
assert.equal(conflicting.kind, 'rejected');
const db = new Database(join(run, 'data', 'daemon.db'), { readonly: true });
try {
  const deliveries = db
    .query(
      "SELECT COUNT(*) AS count FROM job_queue WHERE queue='mailbox' AND json_extract(payload,'$.messageUuid')=?"
    )
    .get(replay.messageId) as { count: number };
  assert.equal(deliveries.count, 1);
  console.log(
    JSON.stringify(
      {
        sessionId: created.sessionId,
        recordId,
        input,
        lostResponse: observed[0],
        replay,
        another,
        conflicting,
        deliveries: deliveries.count,
      },
      null,
      2
    )
  );
} finally {
  db.close();
}
