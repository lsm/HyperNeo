import { afterEach, describe, expect, test } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import { NeoSpeech } from '../../../../src/lib/neo/speech.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';

const secret = 'fixture-saved-voice-key';
const caller = { source: 'mcp' as const, role: 'neo' as const, sessionId: 'neo:test' };

describe('voice.testSpeech', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let speech: NeoSpeech | undefined;
  afterEach(async () => {
    await speech?.dispose();
    server?.stop(true);
  });

  async function run(status: number, body: string | Uint8Array) {
    const requests: { path: string; body: unknown }[] = [];
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        requests.push({ path: new URL(request.url).pathname, body: await request.json() });
        return new Response(body, { status, headers: { 'content-type': 'audio/pcm' } });
      },
    });
    speech = new NeoSpeech(
      new MessageHub(),
      async () => {
        throw new Error('unexpected write');
      },
      () => true,
      `http://127.0.0.1:${server.port}`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => [secret]
    );
    const result = await invokeOperation(
      createOperationRegistry(speech.operations),
      'voice.testSpeech',
      {},
      caller
    );
    expect(result.kind).toBe('completed');
    return { result: result.kind === 'completed' ? result.value : result, requests };
  }

  test('reports audio from the configured speech service', async () => {
    const { result, requests } = await run(200, new Uint8Array([1, 0, 2, 0]));
    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe('/v1/audio/speech');
    expect(requests[0]?.body).toMatchObject({ input: expect.any(String), response_format: 'pcm' });
  });

  test('reports a service error with every saved key redacted', async () => {
    const { result } = await run(401, `Unauthorized: ${secret}`);
    expect(result).toEqual({ ok: false, reason: 'HTTP 401: Unauthorized: [key]' });
  });

  test('does not report success for an empty audio response', async () => {
    const { result } = await run(200, new Uint8Array());
    expect(result).toEqual({ ok: false, reason: 'Speech service returned no audio' });
  });
});
