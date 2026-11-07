import { describe, expect, test } from 'bun:test';
import { subscribeToStructuredLogs, type StructuredLogEvent } from '@hyperneo/shared';
import { NeoSpeechAudio, planSpeechRetry } from '../../../../src/lib/neo/speech-audio.ts';

const target = { id: 'speech-1', sessionId: 'neo:s', clientId: 'phone', text: 'hello' };
const pcm = () =>
  new Response(new Uint8Array([1, 0, 2, 0]), { headers: { 'content-type': 'audio/pcm' } });
const busy = (status: number, retryAfter?: string) =>
  new Response('', { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });

describe('planSpeechRetry', () => {
  test('retries 503 and 429 with bounded exponential backoff', () => {
    expect(planSpeechRetry(503, null, 0, 0, 0)).toEqual({ retryInMs: 1000 });
    expect(planSpeechRetry(429, null, 2, 0, 0)).toEqual({ retryInMs: 4000 });
    expect(planSpeechRetry(503, null, 9, 0, 0)).toEqual({ retryInMs: 10_000 });
  });

  test('honors Retry-After seconds and dates, never below the floor', () => {
    expect(planSpeechRetry(503, '7', 0, 0, 0)).toEqual({ retryInMs: 7000 });
    expect(planSpeechRetry(503, '0', 0, 0, 0)).toEqual({ retryInMs: 250 });
    const now = Date.parse('2026-11-07T12:00:00Z');
    expect(planSpeechRetry(429, 'Sat, 07 Nov 2026 12:00:03 GMT', 0, 0, now)).toEqual({
      retryInMs: 3000,
    });
    expect(planSpeechRetry(503, 'soon', 1, 0, 0)).toEqual({ retryInMs: 2000 });
  });

  test('gives up on other statuses and when the next wait passes the deadline', () => {
    expect(planSpeechRetry(500, null, 0, 0, 0)).toEqual({ giveUp: 'upstream_http_500' });
    expect(planSpeechRetry(404, '1', 0, 0, 0)).toEqual({ giveUp: 'upstream_http_404' });
    expect(planSpeechRetry(503, null, 3, 172_000, 0)).toEqual({ giveUp: 'deadline_exceeded' });
    expect(planSpeechRetry(503, '200', 0, 0, 0)).toEqual({ giveUp: 'deadline_exceeded' });
  });
});

describe('NeoSpeechAudio upstream retry', () => {
  const run = async (responses: Response[]) => {
    const sent: { type: string }[] = [];
    const logs: StructuredLogEvent[] = [];
    const unsubscribe = subscribeToStructuredLogs((event) => {
      if (event.message === 'voice.tts.failed') logs.push(event);
    });
    let calls = 0;
    let failed = 0;
    const audio = new NeoSpeechAudio(
      (_client, data) => {
        sent.push(data);
        return true;
      },
      async () => {
        failed++;
      },
      'https://tts.example.test',
      (async () => responses[calls++] ?? pcm()) as unknown as typeof fetch
    );
    try {
      audio.start(target, 'voice');
      for (let i = 0; i < 400 && !sent.some((m) => m.type === 'end' || m.type === 'failed'); i++)
        await new Promise((done) => setTimeout(done, 5));
      await audio.dispose();
    } finally {
      unsubscribe();
    }
    return { sent: sent.map((m) => m.type), calls, failed, logs };
  };

  test('a warming-up 503 is retried and the reply still plays', async () => {
    const result = await run([busy(503, '0')]);
    expect(result.calls).toBe(2);
    expect(result.sent).toEqual(['audio', 'end']);
    expect(result.failed).toBe(0);
  });

  test('a non-retryable status fails once and logs the status', async () => {
    const result = await run([busy(500)]);
    expect(result.calls).toBe(1);
    expect(result.sent).toEqual(['failed']);
    expect(result.failed).toBe(1);
    expect(result.logs[0]?.metadata).toMatchObject({ reason: 'upstream_http_500', status: 500 });
  });

  test('a wait past the deadline fails visibly with the last status', async () => {
    const result = await run([busy(429, '600')]);
    expect(result.calls).toBe(1);
    expect(result.sent).toEqual(['failed']);
    expect(result.logs[0]?.metadata).toMatchObject({ reason: 'deadline_exceeded', status: 429 });
  });
});
