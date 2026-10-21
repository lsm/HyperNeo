import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallContext, MessageHub } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/database';
import { SettingsManager } from '../../../../src/lib/settings-manager';
import {
  registerVoiceHandlers,
  resetVoiceTranscriptionLimitsForTests,
} from '../../../../src/lib/rpc-handlers/voice-handlers';

type Handler = (data: unknown, context: CallContext) => Promise<unknown>;
const id = '791ef906-b9de-4ddc-adb1-dc4029b74ab9';
const input = {
  recordingId: id,
  audioBase64: Buffer.from('RIFFxxxxWAVEfmt data').toString('base64'),
  mimeType: 'audio/wav',
};
const context = (clientId = 'connection-a'): CallContext => ({
  clientId,
  sessionId: 'global',
  messageId: crypto.randomUUID(),
  method: 'voice.transcribe',
  timestamp: new Date().toISOString(),
});

describe('voice recording retries through registered RPC handlers', () => {
  let directory: string;
  let db: Database;
  let requests: number;
  let handler: Handler;

  const register = () => {
    const handlers = new Map<string, Handler>();
    const hub = {
      onRequest: (name: string, value: Handler) => handlers.set(name, value),
    } as unknown as MessageHub;
    registerVoiceHandlers(hub, new SettingsManager(db), undefined, {
      db: db.getDatabase(),
      deviceOf: () => ({ deviceId: 'synthetic-phone', kind: 'native' }),
    });
    return handlers.get('voice.transcribe')!;
  };

  beforeEach(async () => {
    resetVoiceTranscriptionLimitsForTests();
    directory = await mkdtemp(join(tmpdir(), 'voice-recording-'));
    db = new Database(join(directory, 'daemon.db'));
    await db.initialize();
    new SettingsManager(db).updateGlobalSettings({
      voice: {
        enabled: true,
        endpoint: 'http://127.0.0.1:1/v1/audio/transcriptions',
        model: 'fake',
        allowPrivateNetwork: true,
      },
    });
    requests = 0;
    vi.stubGlobal('fetch', async () => {
      requests++;
      return Response.json({ text: `synthetic result ${requests}` });
    });
    handler = register();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('returns the original result when the phone retries after losing the response', async () => {
    const first = await handler(input, context());
    const second = await handler(input, context('reconnected-phone'));
    expect(second).toEqual(first);
    expect(requests).toBe(1);
  });

  it('joins concurrent requests for one recording instead of refusing or resubmitting', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('fetch', async () => {
      requests++;
      await gate;
      return Response.json({ text: 'one result' });
    });
    const first = handler(input, context());
    const second = handler(input, context('reconnected-phone'));
    release();
    const results = await Promise.all([first, second]);
    expect(results).toEqual([{ text: 'one result' }, { text: 'one result' }]);
    expect(requests).toBe(1);
  });

  it('survives database close and reopen without another ASR request', async () => {
    const first = await handler(input, context());
    db.close();
    db = new Database(join(directory, 'daemon.db'));
    await db.initialize();
    handler = register();
    expect(await handler(input, context('after-restart'))).toEqual(first);
    expect(requests).toBe(1);
  });

  it('refuses changed bytes under an already claimed recording id', async () => {
    await handler(input, context());
    await expect(
      handler(
        { ...input, audioBase64: Buffer.from('different audio').toString('base64') },
        context()
      )
    ).rejects.toThrow('different audio');
    expect(requests).toBe(1);
  });

  it('retains a failed submission so a timeout retry cannot call ASR twice', async () => {
    vi.stubGlobal('fetch', async () => {
      requests++;
      throw new Error('synthetic response lost after acceptance');
    });
    await expect(handler(input, context())).rejects.toThrow('synthetic response lost');
    await expect(handler(input, context('reconnected-phone'))).rejects.toThrow(
      'synthetic response lost'
    );
    expect(requests).toBe(1);
  });

  it('refuses malformed ids before external submission', async () => {
    await expect(handler({ ...input, recordingId: '' }, context())).rejects.toThrow('recordingId');
    expect(requests).toBe(0);
  });

  it('preserves legacy request behavior when recordingId is omitted', async () => {
    const { recordingId: _, ...legacy } = input;
    expect(await handler(legacy, context())).toEqual({ text: 'synthetic result 1' });
    expect(await handler(legacy, context())).toEqual({ text: 'synthetic result 2' });
    expect(requests).toBe(2);
  });
});
