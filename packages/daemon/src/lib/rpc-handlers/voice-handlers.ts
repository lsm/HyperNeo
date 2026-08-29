import type { CallContext, MessageHub } from '@hyperneo/shared';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import type { SettingsManager } from '../settings-manager.ts';
import { createVoiceTranscribeLimiters, runVoiceTranscribe } from '../voice/transcribe-pipeline.ts';

interface VoiceTranscribeRequest {
  audioBase64: string;
  mimeType: 'audio/wav';
}

interface VoiceTranscribeResponse {
  text: string;
}

const transcriptionLimiters = createVoiceTranscribeLimiters();

export function resetVoiceTranscriptionLimitsForTests(): void {
  transcriptionLimiters.activeByClient.clear();
  transcriptionLimiters.rateWindowsByClient.clear();
  transcriptionLimiters.daemonActive.count = 0;
  transcriptionLimiters.daemonRateWindow = { windowStartedAt: 0, count: 0 };
}

export function registerVoiceHandlers(
  messageHub: MessageHub,
  settingsManager: SettingsManager,
  credentialManager?: ProviderCredentialManager
): void {
  messageHub.onRequest<VoiceTranscribeRequest, VoiceTranscribeResponse>(
    'voice.transcribe',
    (data, context) => transcribeViaPipeline(settingsManager, credentialManager, data, context)
  );

  messageHub.onRequest('voice.testConnection', async (_data, context) =>
    transcribeViaPipeline(
      settingsManager,
      credentialManager,
      createTestConnectionRequest(),
      context
    )
  );
}

async function transcribeViaPipeline(
  settingsManager: SettingsManager,
  credentialManager: ProviderCredentialManager | undefined,
  data: VoiceTranscribeRequest,
  context: CallContext | undefined
): Promise<VoiceTranscribeResponse> {
  const outcome = await runVoiceTranscribe({
    data,
    context,
    deps: { settingsManager, credentialManager, limiters: transcriptionLimiters },
  });
  if (outcome.action === 'transcribed') return { text: outcome.text };
  throw new Error(outcome.action === 'denied' ? outcome.message : outcome.error);
}

function createTestConnectionRequest(): VoiceTranscribeRequest {
  return {
    audioBase64: Buffer.from(createSilentWav()).toString('base64'),
    mimeType: 'audio/wav',
  };
}

function createSilentWav(): Uint8Array {
  const sampleRate = 16_000;
  const samples = sampleRate / 10;
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
