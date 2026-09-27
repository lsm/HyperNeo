import type { ChatMessage } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import MarkdownRenderer from '../components/chat/MarkdownRenderer.tsx';
import { CopyButton } from '../components/ui/CopyButton.tsx';
import { useEffect, useRef, useState } from 'preact/hooks';

export function messageTime(timestamp: unknown, now = new Date()) {
  if (typeof timestamp !== 'number' && typeof timestamp !== 'string') return null;
  if (timestamp === '') return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const today = date.toDateString() === now.toDateString();
  return {
    iso: date.toISOString(),
    full: date.toLocaleString(),
    label: today
      ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : date.toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
        }),
  };
}

export function NeoMessage({
  message,
  text,
  work,
  activity,
  sessionId,
}: {
  message: ChatMessage;
  text: string;
  work?: NeoWork;
  activity?: string[];
  sessionId?: string;
}) {
  const user = message.type === 'user';
  const [showActivity, setShowActivity] = useState(false);
  const activityPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showActivity) activityPanel.current?.scrollIntoView?.({ block: 'nearest' });
  }, [showActivity]);
  const content =
    message.type === 'user' || message.type === 'assistant' ? message.message?.content : null;
  const images = Array.isArray(content)
    ? content.flatMap((block) => {
        if (
          block.type !== 'image' ||
          block.source.type !== 'base64' ||
          !/^image\/(png|jpeg|gif|webp)$/.test(block.source.media_type)
        )
          return [];
        return [`data:${block.source.media_type};base64,${block.source.data}`];
      })
    : [];
  const time = messageTime((message as ChatMessage & { timestamp?: number }).timestamp);
  return (
    <article
      class={`neo-arrive neo-message w-fit break-words ${user ? 'neo-message-user ml-auto max-w-[78%]' : 'neo-message-assistant mr-auto max-w-[94%]'}`}
    >
      <div
        class={`mb-2 flex flex-wrap items-baseline gap-x-2 px-1 text-xs ${user ? 'justify-end' : ''}`}
      >
        <span class="neo-message-name font-medium">{user ? 'You' : 'Neo'}</span>
        {time && (
          <time dateTime={time.iso} title={time.full} class="neo-message-time text-[11px]">
            {time.label}
          </time>
        )}
      </div>
      <div
        class={`neo-message-bubble rounded-2xl border px-4 py-3 ${user ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}
      >
        {images.length > 0 && (
          <div class="mb-3 flex flex-wrap gap-2">
            {images.map((src, index) => (
              <img
                key={index}
                src={src}
                alt={`Attached photo ${index + 1}`}
                class="max-h-64 max-w-full rounded-xl object-contain"
              />
            ))}
          </div>
        )}
        {/^\s*\d+[.)]?\s*$/.test(text) ? (
          <p class="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
        ) : (
          <MarkdownRenderer
            content={text}
            class={`neo-markdown ${user ? 'neo-markdown-user' : 'neo-markdown-assistant'} text-sm leading-relaxed`}
          />
        )}
        {work?.report && !user && (
          <details class="mt-4 border-t border-line pt-3">
            <summary class="cursor-pointer text-sm font-medium text-accent hover:underline">
              Read result · {work.title}
            </summary>
            <div class="mt-3 rounded-xl border border-line bg-surface p-4">
              <p class="mb-3 text-xs text-fg-muted">
                HyperNeo’s response, not independently verified.
              </p>
              <MarkdownRenderer
                content={work.report}
                class="neo-markdown neo-markdown-assistant text-sm leading-relaxed"
              />
              <CopyButton text={work.report} label="Copy work result" />
            </div>
          </details>
        )}
      </div>
      <div class={`mt-1 flex items-center gap-3 ${user ? 'justify-end' : ''}`}>
        <CopyButton text={text} label={user ? 'Copy your message' : 'Copy Neo’s message'} />
        {!user && sessionId && (
          <button
            type="button"
            aria-expanded={showActivity}
            onClick={() => setShowActivity(!showActivity)}
            class="text-xs text-fg-muted hover:text-fg"
          >
            {showActivity ? 'Hide activity' : 'What happened'}
          </button>
        )}
      </div>
      {showActivity && sessionId && (
        <div
          ref={activityPanel}
          class="neo-activity-panel mt-2 min-w-[min(17rem,calc(100vw-2.5rem))] rounded-xl border border-line bg-surface p-3 text-xs text-fg-muted"
        >
          {activity?.length ? (
            <ul class="space-y-1.5">
              {activity.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          ) : (
            <p>Neo answered directly.</p>
          )}
          <a
            href={`/session/${sessionId}`}
            target="_blank"
            rel="noreferrer"
            class="mt-3 inline-block text-accent hover:underline"
          >
            Open technical trace ↗
          </a>
        </div>
      )}
    </article>
  );
}
