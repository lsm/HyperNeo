import { isSDKSystemInit, type SDKMessage } from '@hyperneo/shared/sdk';

export function isMeaningfulSdkStartupProgress(message: SDKMessage): boolean {
  if (
    message.type === 'assistant' ||
    message.type === 'user' ||
    message.type === 'result' ||
    message.type === 'stream_event'
  ) {
    return true;
  }
  return isSDKSystemInit(message);
}
