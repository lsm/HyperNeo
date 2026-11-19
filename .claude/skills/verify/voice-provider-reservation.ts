import assert from 'node:assert/strict';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
const port = process.env.VERIFY_PORT;
assert(port && port !== '8399');
assert(process.env.HYPERNEO_DATA_DIR, 'set HYPERNEO_DATA_DIR to the isolated run');
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
  headers: { authorization: `Bearer ${await readLocalCredential()}` },
} as unknown as string[]);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
const pending = new Map<
  string,
  { resolve: (data: unknown) => void; reject: (error: Error) => void }
>();
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  const handler = pending.get(message.requestId ?? message.id);
  if (!handler) return;
  pending.delete(message.requestId ?? message.id);
  if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
  else handler.resolve(message.data);
};
function call(method: string, data: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
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
}
try {
  await assert.rejects(call('providers.create', {
    params: { providerId: 'voice-transcription:old.example', displayName: 'Blocked', kind: 'built_in', authType: 'none' },
  }), /reserved/);
  const updated = await call('providers.update', { id: 'synthetic-legacy-provider', params: { displayName: 'Updated', isEnabled: false } }) as { success: boolean; provider: { displayName: string } };
  assert.equal(updated.success, true);
  assert.equal(updated.provider.displayName, 'Updated');
  const deleted = await call('providers.delete', { id: 'synthetic-legacy-provider' }) as { success: boolean };
  assert.equal(deleted.success, true);
  console.log(JSON.stringify({ createRefused: true, legacyUpdated: true, legacyDeleted: true }));
} finally {
  socket.close();
}
