import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import { useEffect, useState } from 'preact/hooks';
import { copyToClipboard } from '../../../lib/utils';
import { messageSpacing } from '../../../lib/design-tokens';
import { Dropdown } from '../../ui/Dropdown';
import { IconButton } from '../../ui/IconButton';
import { Tooltip } from '../../ui/Tooltip';
import { MessageInfoButton } from '../../sdk/MessageInfoButton';
import { MessageInfoDropdown } from '../../sdk/MessageInfoDropdown';
import { ResultInfoButton } from '../../sdk/ResultInfoButton';
import { ResultInfoDropdown } from '../../sdk/ResultInfoDropdown';

type SystemInitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;
type ResultMessage = Extract<SDKMessage, { type: 'result' }>;

interface SpaceTaskThreadMessageActionsProps {
  timestamp: number;
  copyText: string;
  align?: 'left' | 'right';
  onOpenSession?: () => void;
  openSessionTitle?: string;
  sessionInit?: SystemInitMessage;
  resultInfo?: ResultMessage;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatFullTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function SpaceTaskThreadMessageActions({
  timestamp,
  copyText,
  align = 'left',
  onOpenSession,
  openSessionTitle,
  sessionInit,
  resultInfo,
}: SpaceTaskThreadMessageActionsProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const onCopy = async () => {
    const ok = await copyToClipboard(copyText);
    if (ok) setCopied(true);
  };

  const resultIsError = resultInfo !== undefined && resultInfo.subtype !== 'success';

  return (
    <div
      class={`flex items-center ${messageSpacing.actions.gap} ${messageSpacing.actions.marginTop} ${messageSpacing.actions.padding} ${
        align === 'right' ? 'justify-end' : ''
      }`}
    >
      <Tooltip content={formatFullTime(timestamp)} position={align === 'right' ? 'left' : 'right'}>
        <span class="text-xs text-gray-400">{formatTime(timestamp)}</span>
      </Tooltip>

      {sessionInit && (
        <Dropdown
          trigger={<MessageInfoButton />}
          items={[]}
          position={align === 'right' ? 'right' : 'left'}
          customContent={<MessageInfoDropdown sessionInfo={sessionInit} />}
        />
      )}

      {resultInfo && (
        <Dropdown
          trigger={<ResultInfoButton isError={resultIsError} />}
          items={[]}
          position={align === 'right' ? 'right' : 'left'}
          customContent={<ResultInfoDropdown result={resultInfo} />}
        />
      )}

      <IconButton
        size="md"
        onClick={onCopy}
        title={copied ? 'Copied!' : 'Copy message'}
        class={copied ? 'text-green-400' : ''}
      >
        {copied ? (
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        )}
      </IconButton>

      {onOpenSession && (
        <IconButton size="md" onClick={onOpenSession} title={openSessionTitle ?? 'Open in session'}>
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
        </IconButton>
      )}
    </div>
  );
}
