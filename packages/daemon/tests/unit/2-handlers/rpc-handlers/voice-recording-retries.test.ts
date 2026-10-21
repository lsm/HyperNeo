import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallContext, MessageHub } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/database';
import type { ProviderCredentialManager } from '../../../../src/lib/credentials/provider-credential-manager';
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

  const register = (
    credentials?: ProviderCredentialManager,
    settings = new SettingsManager(db)
  ) => {
    const handlers = new Map<string, Handler>();
    const hub = {
      onRequest: (name: string, value: Handler) => handlers.set(name, value),
    } as unknown as MessageHub;
    registerVoiceHandlers(hub, settings, credentials, {
      db: db.getDatabase(),
      deviceOf: () => ({ deviceId: 'synthetic-phone', kind: 'human' }),
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

  it('never re-submits an interrupted durable reservation with no saved result', async () => {
    const hash = createHash('sha256')
      .update(Buffer.from(input.audioBase64, 'base64'))
      .digest('hex');
    db.getDatabase()
      .prepare(
        'INSERT INTO voice_recordings (owner, recording_id, audio_sha256, created_at, dispatched_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('synthetic-phone', id, hash, Date.now(), Date.now());
    await expect(handler(input, context('after-interruption'))).rejects.toThrow('unconfirmed');
    await expect(handler(input, context('another-retry'))).rejects.toThrow('unconfirmed');
    expect(requests).toBe(0);
  });

  it('does not share a saved transcript with a different paired device', async () => {
    await handler(input, context());
    const handlers = new Map<string, Handler>();
    const hub = {
      onRequest: (name: string, value: Handler) => handlers.set(name, value),
    } as unknown as MessageHub;
    registerVoiceHandlers(hub, new SettingsManager(db), undefined, {
      db: db.getDatabase(),
      deviceOf: () => ({ deviceId: 'other-phone', kind: 'human' }),
    });
    expect(await handlers.get('voice.transcribe')!(input, context('other-client'))).toEqual({
      text: 'synthetic result 2',
    });
    expect(requests).toBe(2);
  });

  it('matches recording id case while comparing the submitted audio bytes', async () => {
    const first = await handler(input, context());
    expect(
      await handler({ ...input, recordingId: id.toUpperCase() }, context('reconnected-phone'))
    ).toEqual(first);
    expect(requests).toBe(1);
  });

  it('retries the same recording after voice setup is repaired before dispatch', async () => {
    const settings = new SettingsManager(db);
    const voice = settings.getGlobalSettings().voice!;
    settings.updateGlobalSettings({ voice: { ...voice, enabled: false } });
    await expect(handler(input, context())).rejects.toThrow('disabled');
    expect(requests).toBe(0);
    settings.updateGlobalSettings({ voice });
    expect(await handler(input, context())).toEqual({ text: 'synthetic result 1' });
    expect(requests).toBe(1);
  });

  it('retries a second recording after the first upload releases its concurrency slot', async () => {
    let release: () => void = () => {};
    let accepted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('fetch', async () => {
      const call = ++requests;
      accepted();
      if (call === 1) await gate;
      return Response.json({ text: `synthetic result ${call}` });
    });
    const first = handler(input, context());
    await started;
    const second = { ...input, recordingId: crypto.randomUUID() };
    try {
      await expect(handler(second, context())).rejects.toThrow('already in progress');
      expect(requests).toBe(1);
    } finally {
      release();
      await first;
    }
    expect(await handler(second, context())).toEqual({ text: 'synthetic result 2' });
    expect(requests).toBe(2);
  });

  it('retries an identical recording after credential lookup fails before dispatch', async () => {
    const settings = new SettingsManager(db);
    settings.updateGlobalSettings({
      voice: {
        ...settings.getGlobalSettings().voice!,
        apiKeyEndpoint: 'http://127.0.0.1:1/v1/audio/transcriptions',
      },
    });
    let failed = true;
    handler = register({
      getCredentials: async () => {
        if (failed) throw new Error('synthetic credential lookup failure');
        return null;
      },
    } as unknown as ProviderCredentialManager);
    await expect(handler(input, context())).rejects.toThrow('synthetic credential lookup failure');
    expect(requests).toBe(0);
    failed = false;
    expect(await handler(input, context())).toEqual({ text: 'synthetic result 1' });
    expect(requests).toBe(1);
  });

  it('retries after a rate-limit window clears without changing recording identity', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      for (let index = 0; index < 6; index++)
        await handler({ ...input, recordingId: crypto.randomUUID() }, context());
      await expect(handler(input, context())).rejects.toThrow('rate limit exceeded');
      expect(requests).toBe(6);
      clock.mockReturnValue(now + 61_000);
      expect(await handler(input, context())).toEqual({ text: 'synthetic result 7' });
      expect(requests).toBe(7);
    } finally {
      clock.mockRestore();
    }
  });

  it('retries after endpoint policy rejects before any network dispatch', async () => {
    const settings = new SettingsManager(db);
    const voice = settings.getGlobalSettings().voice!;
    settings.updateGlobalSettings({ voice: { ...voice, allowPrivateNetwork: false } });
    await expect(handler(input, context())).rejects.toThrow('private');
    expect(requests).toBe(0);
    settings.updateGlobalSettings({ voice });
    expect(await handler(input, context())).toEqual({ text: 'synthetic result 1' });
    expect(requests).toBe(1);
  });

  it('can resume a reservation interrupted before any dispatch', async () => {
    const hash = createHash('sha256')
      .update(Buffer.from(input.audioBase64, 'base64'))
      .digest('hex');
    db.getDatabase()
      .prepare(
        'INSERT INTO voice_recordings (owner, recording_id, audio_sha256, created_at) VALUES (?, ?, ?, ?)'
      )
      .run('synthetic-phone', id, hash, Date.now());
    expect(await handler(input, context('after-preflight-interruption'))).toEqual({
      text: 'synthetic result 1',
    });
    expect(requests).toBe(1);
  });

  it('allows only one independently registered handler to dispatch without poisoning its result', async () => {
    const settings = new SettingsManager(db);
    settings.updateGlobalSettings({
      voice: {
        ...settings.getGlobalSettings().voice!,
        apiKeyEndpoint: 'http://127.0.0.1:1/v1/audio/transcriptions',
      },
    });
    let allowCredentials: () => void = () => {};
    let sawCredentials: () => void = () => {};
    let sawPeer: () => void = () => {};
    let releaseAsr: () => void = () => {};
    let sawAsr: () => void = () => {};
    let lookups = 0;
    const asrStarted = new Promise<void>((resolve) => {
      sawAsr = resolve;
    });
    const credentialGate = new Promise<void>((resolve) => {
      allowCredentials = resolve;
    });
    const credentialStarted = new Promise<void>((resolve) => {
      sawCredentials = resolve;
    });
    const peerPrepared = new Promise<void>((resolve) => {
      sawPeer = resolve;
    });
    const asrGate = new Promise<void>((resolve) => {
      releaseAsr = resolve;
    });
    const credentials = {
      getCredentials: async () => {
        if (++lookups === 1) {
          sawCredentials();
          await credentialGate;
        } else await asrStarted;
        return null;
      },
    } as unknown as ProviderCredentialManager;
    handler = register(credentials);
    const peerSettings = new SettingsManager(db);
    const read = vi.spyOn(peerSettings, 'getGlobalSettings').mockImplementation(() => {
      sawPeer();
      return db.getGlobalSettings();
    });
    const peer = register(credentials, peerSettings);
    vi.stubGlobal('fetch', async () => {
      requests++;
      sawAsr();
      await asrGate;
      return Response.json({ text: 'one accepted result' });
    });
    const first = handler(input, context('first-client'));
    await credentialStarted;
    const competing = peer(input, context('second-client')).catch((error: Error) => error.message);
    await peerPrepared;
    allowCredentials();
    try {
      expect(await competing).toContain('already dispatched');
      expect(requests).toBe(1);
    } finally {
      releaseAsr();
      await first;
      read.mockRestore();
    }
    expect(await peer(input, context('later-retry'))).toEqual({ text: 'one accepted result' });
    expect(requests).toBe(1);
  });

  it('preserves legacy request behavior when recordingId is omitted', async () => {
    const { recordingId: _, ...legacy } = input;
    expect(await handler(legacy, context())).toEqual({ text: 'synthetic result 1' });
    expect(await handler(legacy, context())).toEqual({ text: 'synthetic result 2' });
    expect(requests).toBe(2);
  });
});
