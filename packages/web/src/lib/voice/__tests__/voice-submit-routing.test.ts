import { describe, expect, it } from 'vitest';
import {
  VOICE_SUBMIT_MAX_RETRY_DELAY_MS,
  VOICE_SUBMIT_RETRY_DELAY_MS,
  classifyVoiceSubmitError,
  routeVoiceOutcome,
  voiceRetryPolicy,
} from '../voice-submit-routing.ts';
import { isPermanentAppendRefusal } from '../voice-transcript-outbox.ts';

describe('classifyVoiceSubmitError', () => {
  it.each([
    'Voice transcription rate limit exceeded; please wait before trying again',
    'Voice transcription daemon-wide rate limit exceeded; please wait before trying again',
    'Too many voice transcription requests are already in progress',
    'Voice transcription is already in progress for this client',
  ])('classifies daemon admission gates as retry: %s', (message) => {
    expect(classifyVoiceSubmitError(new Error(message))).toBe('retry');
  });

  it.each([
    'Voice transcription timed out after 60 seconds',
    'Voice transcription endpoint resolution timed out',
    'Voice transcription credential lookup timed out',
    'Request timeout: voice.transcribe (125000ms)',
    'Voice transcription request failed',
    'fetch failed',
    'Not connected',
  ])('classifies network and timeout failures as retry: %s', (message) => {
    expect(classifyVoiceSubmitError(new Error(message))).toBe('retry');
  });

  it('classifies abort exceptions as retry', () => {
    expect(classifyVoiceSubmitError(new DOMException('aborted', 'AbortError'))).toBe('retry');
  });

  it.each([
    'Voice transcription requires audio/wav input',
    'Audio data is required',
    'Audio data is empty',
    'Audio data exceeds the 10 MB voice input limit',
    'Audio data must be valid base64',
    'Voice input is disabled',
    'Voice transcription endpoint is required',
    'Voice transcription model is required',
    'Voice transcription endpoint must be a valid URL',
    'Voice transcription endpoint must use http:// or https://',
    'Voice transcription redirected too many times',
    'Voice transcription returned an invalid redirect',
    'Voice transcription redirect must use http:// or https://',
    'Voice transcription cannot follow an HTTPS-to-HTTP redirect',
    'Voice transcription response exceeds the 256 KB limit',
    'Voice transcription API keys are only sent over HTTPS. Use an HTTPS endpoint or remove the API key.',
    'Voice transcription endpoint targets a private, loopback, or link-local address.',
  ])('classifies payload and config refusals as discard: %s', (message) => {
    expect(classifyVoiceSubmitError(new Error(message))).toBe('discard');
  });

  it('classifies session refusal as permanent, aligned with isPermanentAppendRefusal', () => {
    const error = new Error('Session not found: abc123');
    expect(classifyVoiceSubmitError(error)).toBe('permanent');
    expect(isPermanentAppendRefusal(error)).toBe(true);
  });

  it('never treats non-session refusals as permanent', () => {
    expect(isPermanentAppendRefusal(new Error('Audio data is empty'))).toBe(false);
    expect(classifyVoiceSubmitError(new Error('Audio data is empty'))).toBe('discard');
  });

  it.each([
    ['unknown Error', new Error('something unprecedented')],
    ['string throw', 'socket hang up'],
    ['undefined throw', undefined],
    ['plain object', { message: 'nope' }],
  ])('falls back to retry for unrecognized %s', (_label, error) => {
    expect(classifyVoiceSubmitError(error)).toBe('retry');
  });

  it.each([
    'Voice transcription produced no response',
    'Transcription response did not include text',
  ])('retries response-shape failures that may be transient: %s', (message) => {
    expect(classifyVoiceSubmitError(new Error(message))).toBe('retry');
  });

  it.each([
    400, 401, 403, 404, 405, 406, 410, 413, 414, 415, 422, 426, 451,
  ])('discards deterministic client failures: failed with HTTP %i', (status) => {
    expect(
      classifyVoiceSubmitError(new Error(`Voice transcription failed with HTTP ${status}`))
    ).toBe('discard');
  });

  it.each([
    408, 409, 421, 423, 425, 429, 500, 502, 503, 504,
  ])('retries transient statuses: failed with HTTP %i', (status) => {
    expect(
      classifyVoiceSubmitError(
        new Error(`Voice transcription failed with HTTP ${status}`),
        'transcribe'
      )
    ).toBe('retry');
  });

  it.each([
    ['Invalid model', 400, 'discard'],
    ['request failed', 400, 'discard'],
    ['failed with HTTP 400', 500, 'retry'],
    ['backend exploded', 500, 'retry'],
  ])('classifies %s (failed with HTTP %i) as %s', (body, status, expected) => {
    expect(classifyVoiceSubmitError(new Error(`${body} (failed with HTTP ${status})`))).toBe(
      expected
    );
  });

  it('extracts the final HTTP status marker across line breaks', () => {
    expect(classifyVoiceSubmitError(new Error('request failed\n(failed with HTTP 400)'))).toBe(
      'discard'
    );
    expect(
      classifyVoiceSubmitError(new Error('failed with HTTP 400\n(failed with HTTP 500)'))
    ).toBe('retry');
  });

  it('scopes session refusal to draft delivery', () => {
    const error = new Error('Session not found: abc123');
    expect(classifyVoiceSubmitError(error)).toBe('permanent');
    expect(classifyVoiceSubmitError(error, 'transcribe')).toBe('retry');
    expect(classifyVoiceSubmitError(new Error('Voice transcription failed with HTTP 401'))).toBe(
      'discard'
    );
  });
});

describe('voiceRetryPolicy', () => {
  it('doubles from the base delay and caps at the max', () => {
    expect(voiceRetryPolicy(0)).toBe(5_000);
    expect(voiceRetryPolicy(1)).toBe(10_000);
    expect(voiceRetryPolicy(2)).toBe(20_000);
    expect(voiceRetryPolicy(3)).toBe(40_000);
    expect(voiceRetryPolicy(4)).toBe(60_000);
    expect(voiceRetryPolicy(10)).toBe(60_000);
    expect(voiceRetryPolicy(1000)).toBe(60_000);
  });

  it('mirrors the outbox retry constants shape', () => {
    expect(VOICE_SUBMIT_RETRY_DELAY_MS).toBe(5_000);
    expect(VOICE_SUBMIT_MAX_RETRY_DELAY_MS).toBe(60_000);
  });

  it.each([
    -1,
    -0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('guards invalid attempt %s', (attempt) => {
    expect(voiceRetryPolicy(attempt)).toBe(5_000);
  });
});

describe('routeVoiceOutcome', () => {
  it('discards with reason when the recording target changed', () => {
    expect(routeVoiceOutcome({ transcript: 'hello', mounted: true, sessionChanged: true })).toEqual(
      {
        kind: 'discard-with-reason',
        reason: 'Recording target changed — transcript discarded',
      }
    );
  });

  it('discards silently when the target changed and no transcript exists', () => {
    expect(routeVoiceOutcome({ transcript: '', mounted: true, sessionChanged: true })).toEqual({
      kind: 'discard-with-reason',
      reason: '',
    });
  });

  it('session change wins over every other input', () => {
    expect(
      routeVoiceOutcome({
        transcript: 'hello',
        mounted: false,
        sessionChanged: true,
        mode: 'send',
        composerFull: true,
        deliveryRefused: true,
      }).kind
    ).toBe('discard-with-reason');
  });

  it('discards with a no-speech reason when mounted', () => {
    expect(routeVoiceOutcome({ transcript: '', mounted: true, sessionChanged: false })).toEqual({
      kind: 'discard-with-reason',
      reason: 'No speech detected in that recording',
    });
  });

  it('discards silently when unmounted without transcript', () => {
    expect(routeVoiceOutcome({ transcript: '', mounted: false, sessionChanged: false })).toEqual({
      kind: 'discard-with-reason',
      reason: '',
    });
  });

  it('inserts without auto-send for stay mode', () => {
    expect(
      routeVoiceOutcome({ transcript: 'hello', mounted: true, sessionChanged: false })
    ).toEqual({ kind: 'insert', transcript: 'hello', autoSend: false });
  });

  it.each(['send', 'queue'] as const)('inserts with auto-send for %s mode', (mode) => {
    expect(
      routeVoiceOutcome({ transcript: 'hello', mounted: true, sessionChanged: false, mode })
    ).toEqual({ kind: 'insert', transcript: 'hello', autoSend: true });
  });

  it('inserts even when the composer snapshot is full', () => {
    expect(
      routeVoiceOutcome({
        transcript: 'hello',
        mounted: true,
        sessionChanged: false,
        mode: 'send',
        composerFull: true,
      }).kind
    ).toBe('insert');
  });

  it.each([
    'stay',
    'send',
    'queue',
  ] as const)('delivers unmounted transcripts for %s mode', (mode) => {
    expect(
      routeVoiceOutcome({ transcript: 'hello', mounted: false, sessionChanged: false, mode })
    ).toEqual({ kind: 'deliver-unmounted', transcript: 'hello', mode });
  });

  it('defaults unmounted delivery to stay mode', () => {
    expect(
      routeVoiceOutcome({ transcript: 'hello', mounted: false, sessionChanged: false })
    ).toEqual({ kind: 'deliver-unmounted', transcript: 'hello', mode: 'stay' });
  });

  it('persists for resend when the composer snapshot is full', () => {
    expect(
      routeVoiceOutcome({
        transcript: 'hello',
        mounted: false,
        sessionChanged: false,
        mode: 'send',
        composerFull: true,
      })
    ).toEqual({
      kind: 'persist-for-resend',
      transcript: 'hello',
      reason: 'Composer draft is full — voice transcript saved to the session draft',
    });
  });

  it('persists for resend when direct delivery was refused', () => {
    expect(
      routeVoiceOutcome({
        transcript: 'hello',
        mounted: false,
        sessionChanged: false,
        mode: 'queue',
        deliveryRefused: true,
      })
    ).toEqual({
      kind: 'persist-for-resend',
      transcript: 'hello',
      reason: 'Voice send failed — transcript saved to the session draft',
    });
  });

  it('composer-full outranks delivery refusal', () => {
    expect(
      routeVoiceOutcome({
        transcript: 'hello',
        mounted: false,
        sessionChanged: false,
        mode: 'send',
        composerFull: true,
        deliveryRefused: true,
      })
    ).toEqual({
      kind: 'persist-for-resend',
      transcript: 'hello',
      reason: 'Composer draft is full — voice transcript saved to the session draft',
    });
  });

  it('stay mode stages to the draft regardless of the failure flags', () => {
    expect(
      routeVoiceOutcome({
        transcript: 'hello',
        mounted: false,
        sessionChanged: false,
        mode: 'stay',
        composerFull: true,
        deliveryRefused: true,
      })
    ).toEqual({ kind: 'deliver-unmounted', transcript: 'hello', mode: 'stay' });
  });
});
