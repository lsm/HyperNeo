import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { MessageHub } from '@hyperneo/shared';
import { NeoSpeech } from '../../../../src/lib/neo/speech.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { withVoiceCredentialLock } from '../../../../src/lib/rpc-handlers/voice-credential-lock.ts';

const secret = 'fixture-saved-voice-key';
const caller = { source: 'mcp' as const, role: 'neo' as const, sessionId: 'neo:test' };

describe('voice.testSpeech', () => {
  let server: Server | undefined;
  let speech: NeoSpeech | undefined;
  afterEach(async () => {
    await speech?.dispose();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  async function setup(status: number, body: string | Uint8Array, gate?: Promise<void>) {
    const requests: { path: string; body: unknown }[] = [];
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        path: new URL(request.url ?? '', 'http://127.0.0.1').pathname,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      started();
      await gate;
      response.writeHead(status, { 'content-type': 'audio/pcm' });
      response.end(body);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No server address');
    const keys = [secret];
    speech = new NeoSpeech(
      new MessageHub(),
      async () => {
        throw new Error('unexpected write');
      },
      () => true,
      `http://127.0.0.1:${address.port}`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => [...keys]
    );
    const call = async () => {
      const result = await invokeOperation(
        createOperationRegistry(speech!.operations),
        'voice.testSpeech',
        {},
        caller
      );
      expect(result.kind).toBe('completed');
      return result.kind === 'completed' ? result.value : result;
    };
    return { call, requests, requestStarted, keys };
  }

  test('reports audio from the configured speech service', async () => {
    const { call, requests } = await setup(200, new Uint8Array([1, 0, 2, 0]));
    expect(await call()).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe('/v1/audio/speech');
    expect(requests[0]?.body).toMatchObject({ input: expect.any(String), response_format: 'pcm' });
  });

  test('reports a service error with every saved key redacted', async () => {
    const { call } = await setup(401, `Unauthorized: ${secret}`);
    expect(await call()).toEqual({ ok: false, reason: 'HTTP 401: Unauthorized: [key]' });
  });

  test('does not report success for an empty audio response', async () => {
    const { call } = await setup(200, new Uint8Array());
    expect(await call()).toEqual({ ok: false, reason: 'Speech service returned no audio' });
  });

  test('credential updates continue during synthesis and their keys are redacted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const added = 'fixture-new-voice-key';
    const { call, requestStarted, keys } = await setup(401, `Unauthorized: ${added}`, gate);
    const pending = call();
    try {
      await requestStarted;
      await Promise.race([
        withVoiceCredentialLock(async () => {
          keys.push(added);
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('credential update blocked')), 500)
        ),
      ]);
    } finally {
      release();
    }
    expect(await pending).toEqual({ ok: false, reason: 'HTTP 401: Unauthorized: [key]' });
  });
});
