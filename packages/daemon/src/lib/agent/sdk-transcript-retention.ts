import type { Settings } from '@anthropic-ai/claude-agent-sdk';

export const SDK_TRANSCRIPT_RETENTION_DAYS = 3650;

export function withSdkTranscriptRetention(settings?: Settings): Settings {
  return { ...settings, cleanupPeriodDays: SDK_TRANSCRIPT_RETENTION_DAYS };
}
