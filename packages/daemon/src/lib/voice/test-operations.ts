import WebSocket from 'ws';
import superpipe, { type PipelineAPI, type SuperPipeFactory } from 'superpipe';
import { z } from 'zod';
import { neoToolDescription } from '@hyperneo/prompts';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import type { SettingsManager } from '../settings-manager.ts';
import { defineOperation } from '../operations/registry.ts';
import { withVoiceCredentialLock } from '../rpc-handlers/voice-credential-lock.ts';
import {
  buildAsrRelayOpen,
  pcm16Wav,
  voiceStreamRoute,
  type VoiceStreamDeps,
} from './stream-relay.ts';
import { createVoiceTranscribeLimiters, runVoiceTranscribe } from './transcribe-pipeline.ts';

const Result = z.object({ ok: z.boolean(), reason: z.string().optional() });
type Result = { ok: true } | { ok: false; reason: string };

async function savedKeys(settings: SettingsManager, credentials?: ProviderCredentialManager) {
  const ids = (await credentials?.listCredentialProviderIds()) ?? [];
  const values = await Promise.all(
    ids
      .filter((id) => id === 'voice-transcription' || id.startsWith('voice-transcription:'))
      .map((id) => credentials!.getCredentials(id))
  );
  return [
    settings.getGlobalSettings().voice?.apiKey,
    ...values.map((value) => (value?.type === 'api_key' ? value.apiKey : undefined)),
  ].filter((key): key is string => !!key);
}

async function checkLive(
  settings: SettingsManager,
  credentials?: ProviderCredentialManager
): Promise<Result> {
  const voice = settings.getGlobalSettings().voice;
  if (!voice?.enabled) return { ok: false, reason: 'Voice input is disabled' };
  const route = voiceStreamRoute(voice);
  if (!route)
    return { ok: false, reason: 'The voice endpoint has no streaming transcription route' };
  const deps: VoiceStreamDeps = {
    voice: () => voice,
    credentialManager: credentials,
    push: () => {},
    transcribeWav: async () => ({ action: 'failed', error: 'Batch unavailable' }),
  };
  const open = await buildAsrRelayOpen(crypto.randomUUID(), voice, route.url, route.protocol, deps);
  if ('reason' in open) return { ok: false, reason: open.reason };
  return new Promise((resolve) => {
    const socket = new WebSocket(open.value.url, open.value.wsOptions as WebSocket.ClientOptions);
    let settled = false;
    const finish = (result: Result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: 'Live voice service timed out' }),
      10000
    );
    socket.on('unexpected-response', (_request, response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 65536) {
          response.destroy();
          finish({ ok: false, reason: `HTTP ${response.statusCode}: response too large` });
        } else chunks.push(chunk);
      });
      response.on('end', () =>
        finish({
          ok: false,
          reason: `HTTP ${response.statusCode}: ${Buffer.concat(chunks).toString().trim()}`,
        })
      );
      response.on('error', () =>
        finish({ ok: false, reason: `HTTP ${response.statusCode}: response unavailable` })
      );
    });
    socket.on('error', (error) => finish({ ok: false, reason: error.message }));
    socket.on('open', () => {
      for (const message of route.protocol.opening()) socket.send(message);
      socket.send(route.protocol.audio(new Uint8Array(32000)));
      socket.send(route.protocol.finish());
    });
    socket.on('message', (data) => {
      const raw = data.toString();
      const parsed = route.protocol.parse(raw);
      if (parsed?.end !== undefined) finish(parsed.end ? { ok: true } : { ok: false, reason: raw });
      else {
        try {
          const message = JSON.parse(raw) as { type?: string; error?: unknown };
          if (message.type === 'error' || message.error) finish({ ok: false, reason: raw });
        } catch {}
      }
    });
    socket.on('close', (code) =>
      finish(
        code === 1000 ? { ok: true } : { ok: false, reason: `Live voice service closed (${code})` }
      )
    );
  });
}

export function createVoiceTestOperations(
  settings: SettingsManager,
  credentials?: ProviderCredentialManager
) {
  const limiters = createVoiceTranscribeLimiters();
  const run = (
    operation: 'voice.testConnection' | 'voice.testLive',
    pipeline: ReturnType<SuperPipeFactory>
  ) =>
    (pipeline as PipelineAPI)
      .pipe(
        async () => withVoiceCredentialLock(() => savedKeys(settings, credentials)),
        undefined,
        'keys'
      )
      .pipe(
        async () => {
          if (operation === 'voice.testLive') return checkLive(settings, credentials);
          const data = {
            audioBase64: Buffer.from(pcm16Wav(new Uint8Array(3200))).toString('base64'),
            mimeType: 'audio/wav',
          };
          const outcome = await runVoiceTranscribe({
            data,
            interactive: true,
            deps: { settingsManager: settings, credentialManager: credentials, limiters },
          });
          return outcome.action === 'transcribed'
            ? { ok: true }
            : { ok: false, reason: outcome.action === 'denied' ? outcome.message : outcome.error };
        },
        undefined,
        'result'
      )
      .pipe(
        async (result: Result, keys: string[]) => {
          if (result.ok) return result;
          return withVoiceCredentialLock(async () => {
            let reason = result.reason;
            for (const key of [...keys, ...(await savedKeys(settings, credentials))].sort(
              (a, b) => b.length - a.length
            ))
              reason = reason.replaceAll(key, '[key]');
            return { ok: false, reason: reason.slice(0, 500) };
          });
        },
        ['result', 'keys'],
        'result'
      )
      .endAsync('result') as () => Promise<Result>;
  return [
    defineOperation({
      name: 'voice.testConnection',
      description: neoToolDescription('voice.testConnection'),
      inputSchema: z.object({}),
      resultSchema: Result,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: run('voice.testConnection', superpipe({})('voice.testConnection')),
    }),
    defineOperation({
      name: 'voice.testLive',
      description: neoToolDescription('voice.testLive'),
      inputSchema: z.object({}),
      resultSchema: Result,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: run('voice.testLive', superpipe({})('voice.testLive')),
    }),
  ];
}
