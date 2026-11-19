import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, test } from 'vitest';
import { createVoiceTestOperations } from '../../../../src/lib/voice/test-operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import type { SettingsManager } from '../../../../src/lib/settings-manager.ts';
import type { ProviderCredentialManager } from '../../../../src/lib/credentials/provider-credential-manager.ts';

const secret = 'synthetic-voice-secret';
const caller = { source: 'mcp' as const, role: 'neo' as const, sessionId: 'neo:fixture' };

describe('voice test operations', () => {
  let server: Server;
  let sockets: WebSocketServer;
  afterEach(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((done) => sockets.close(() => done()));
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  async function setup(failing = false, realtime = false) {
    let recorded = 0,
      live = 0,
      bytes = 0;
    server = createServer((request, response) => {
      recorded++;
      request.resume();
      response.writeHead(failing ? 401 : 200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          failing ? { error: { message: `Unauthorized: ${secret}` } } : { text: 'heard' }
        )
      );
    });
    sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      live++;
      if (failing) {
        const body = `Unauthorized: ${secret}`;
        socket.end(
          `HTTP/1.1 401 Unauthorized\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
        );
      } else
        sockets.handleUpgrade(request, socket, head, (peer) => {
          peer.on('message', (message, binary) => {
            if (binary) bytes += Buffer.from(message as Uint8Array).byteLength;
            else {
              const data = JSON.parse(message.toString()) as { type: string; audio?: string };
              if (data.type === 'CloseStream') peer.close(1000);
              if (data.type === 'input_audio_buffer.append')
                bytes += Buffer.from(data.audio ?? '', 'base64').length;
              if (data.type === 'input_audio_buffer.commit')
                peer.send(
                  JSON.stringify({
                    type: 'conversation.item.input_audio_transcription.completed',
                    transcript: '',
                  })
                );
            }
          });
        });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const voice = {
      enabled: true,
      mode: 'batch',
      allowPrivateNetwork: true,
      endpoint: `http://127.0.0.1:${address.port}/recorded`,
      model: 'fixture',
      live: {
        provider: realtime ? 'openai-realtime' : 'deepgram',
        endpoint: `ws://127.0.0.1:${address.port}/live`,
      },
    };
    const settings = { getGlobalSettings: () => ({ voice }) } as unknown as SettingsManager;
    const credentials = {
      listCredentialProviderIds: async () => ['voice-transcription:other.example'],
      getCredentials: async (id: string) =>
        id === 'voice-transcription:other.example' ? { type: 'api_key', apiKey: secret } : null,
    } as unknown as ProviderCredentialManager;
    const registry = createOperationRegistry(createVoiceTestOperations(settings, credentials));
    const call = async (name: string) => {
      const result = await invokeOperation(registry, name, {}, caller);
      expect(result.kind).toBe('completed');
      return result.kind === 'completed' ? result.value : result;
    };
    return { call, counts: () => ({ recorded, live, bytes }) };
  }
  test('checks recorded audio and forced streaming without batch fallback', async () => {
    const { call, counts } = await setup();
    expect(await call('voice.testConnection')).toEqual({ ok: true });
    expect(await call('voice.testLive')).toEqual({ ok: true });
    expect(counts()).toEqual({ recorded: 1, live: 1, bytes: 32000 });
  });
  test('redacts saved keys in each service error', async () => {
    const { call, counts } = await setup(true);
    expect(await call('voice.testConnection')).toEqual({
      ok: false,
      reason: 'Unauthorized: [key] (failed with HTTP 401)',
    });
    expect(await call('voice.testLive')).toEqual({
      ok: false,
      reason: 'HTTP 401: Unauthorized: [key]',
    });
    expect(counts()).toEqual({ recorded: 1, live: 1, bytes: 0 });
  });
  test('uses realtime protocol and completes on an empty transcript', async () => {
    const { call, counts } = await setup(false, true);
    expect(await call('voice.testLive')).toEqual({ ok: true });
    expect(counts()).toEqual({ recorded: 0, live: 1, bytes: 47998 });
  });
});
