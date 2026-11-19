import type {
  VoiceLivePart,
  VoiceRecordedPart,
  VoiceSettings,
  VoiceSpeechPart,
} from '@hyperneo/shared';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';

const VOICE_CREDENTIAL_PROVIDER_ID = 'voice-transcription';

export interface VoiceParts {
  recorded?: VoiceRecordedPart;
  live?: VoiceLivePart;
  speech?: VoiceSpeechPart;
}

export function voiceParts(voice: VoiceSettings | undefined): VoiceParts {
  if (!voice) return {};
  const endpoint = voice.endpoint?.trim();
  const live = voice.streamEndpoint?.trim();
  return {
    recorded:
      voice.recorded ??
      (endpoint ? { provider: 'openai', endpoint, model: voice.model?.trim() ?? '' } : undefined),
    live:
      voice.live ??
      (live ? { provider: voice.streamProtocol ?? 'deepgram', endpoint: live } : undefined),
    speech: voice.speech,
  };
}

function hostOf(address: string | undefined): string | undefined {
  try {
    return address ? new URL(address).host : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveVoiceKey(
  voice: VoiceSettings | undefined,
  target: URL,
  credentialManager?: Pick<ProviderCredentialManager, 'getCredentials'>
): Promise<string | undefined> {
  const hostCredentials = await credentialManager?.getCredentials(
    `${VOICE_CREDENTIAL_PROVIDER_ID}:${target.host}`
  );
  if (hostCredentials?.type === 'api_key' && hostCredentials.apiKey?.trim()) {
    return hostCredentials.apiKey.trim();
  }
  const inline = voice?.apiKey?.trim();
  if (inline)
    return hostOf(voiceParts(voice).recorded?.endpoint) === target.host ? inline : undefined;
  if (hostOf(voice?.apiKeyEndpoint) !== target.host) return undefined;
  const credentials = await credentialManager?.getCredentials(VOICE_CREDENTIAL_PROVIDER_ID);
  return credentials?.type === 'api_key' ? credentials.apiKey?.trim() : undefined;
}

export async function resolveSpeechPart(
  voice: VoiceSettings | undefined,
  credentialManager?: Pick<ProviderCredentialManager, 'getCredentials'>
): Promise<
  | {
      provider?: 'openai' | 'deepgram';
      endpoint: string;
      model?: string;
      voice?: string;
      key?: string;
    }
  | undefined
> {
  const speech = voiceParts(voice).speech;
  const endpoint = speech?.endpoint.trim();
  if (!endpoint) return undefined;
  const key = URL.canParse(endpoint)
    ? await resolveVoiceKey(voice, new URL(endpoint), credentialManager)
    : undefined;
  return { provider: speech?.provider, endpoint, model: speech?.model, voice: speech?.voice, key };
}
