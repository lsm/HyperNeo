import type { ChatMessage, ResolvedQuestion } from '@hyperneo/shared';
import type { SessionStore } from '../lib/session-store.ts';
import { useRef, useState } from 'preact/hooks';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoMessage } from './NeoMessage.tsx';
import { useVisibleTick } from '../hooks/useVisibleTick.ts';
import { SDKMessageRenderer } from '../components/sdk/SDKMessageRenderer.tsx';
import { QuestionPrompt } from '../components/QuestionPrompt.tsx';
import { useMessageMaps } from '../hooks/useMessageMaps.ts';

export function conversationText(message: ChatMessage): string {
  if (message.type !== 'assistant' && message.type !== 'user') return '';
  if (message.parent_tool_use_id) return '';
  const content = message.message.content;
  if (typeof content === 'string') return content;
  return (content as unknown[])
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return [];
      const item = block as { type?: string; text?: unknown };
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
    })
    .join('\n\n');
}

function completedConversation(messages: ChatMessage[], workIds: Set<string>): ChatMessage[] {
  const visible: ChatMessage[] = [];
  let reply: ChatMessage | null = null;
  for (const message of messages) {
    const text = conversationText(message);
    if (message.type === 'user' && text && !workIds.has(message.uuid ?? '')) visible.push(message);
    if (message.type === 'assistant' && text) reply = message;
    if (message.type === 'result') {
      if (reply && message.subtype === 'success') visible.push(reply);
      reply = null;
    }
  }
  return visible;
}

export function NeoConversation({
  store,
  sessionId,
  workIds,
}: {
  store: SessionStore;
  sessionId: string;
  workIds: Set<string>;
}) {
  const messages = store.sdkMessages.value;
  const [expanded, setExpanded] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useVisibleTick(60_000);
  const maps = useMessageMaps(messages, sessionId);
  const state = store.agentState.value;
  const pending = state.status === 'waiting_for_input' ? state.pendingQuestion : null;
  const resolved = new Map<string, ResolvedQuestion>(
    Object.entries(store.sessionInfo.value?.metadata.resolvedQuestions ?? {})
  );
  const visible = completedConversation(
    messages.filter((message) => !maps.replacementStatusMap.has(message.uuid ?? '')),
    workIds
  );
  return (
    <>
      <section aria-label="Conversation with Neo" class="space-y-6">
        {store.hasMoreMessages.value && (
          <p class="text-xs text-fg-muted">
            Showing recent conversation.{' '}
            <a
              class="text-accent hover:underline"
              href={`/session/${sessionId}`}
              target="_blank"
              rel="noreferrer"
            >
              Open full history ↗
            </a>
          </p>
        )}
        {visible.map((message) => (
          <NeoMessage key={message.uuid} message={message} text={conversationText(message)} />
        ))}
        {pending && (
          <QuestionPrompt
            pendingHeading="A quick choice"
            key={pending.toolUseId}
            sessionId={sessionId}
            pendingQuestion={pending}
            onResolved={() => void store.refresh()}
          />
        )}
        {store.error.value && (
          <p
            role="alert"
            class="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
          >
            {store.error.value.message}
          </p>
        )}
      </section>
      {messages.length > 0 && (
        <section class="mt-6 text-xs text-fg-muted" aria-label="Conversation details">
          <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <button
              ref={toggle}
              type="button"
              aria-expanded={expanded}
              aria-controls="neo-conversation-details"
              onClick={() => setExpanded(!expanded)}
              class="flex min-h-9 items-center gap-1 hover:text-fg"
            >
              <NeoIcon
                name="chevron"
                class={`!h-3 !w-3 ${expanded ? 'rotate-180' : 'rotate-90'}`}
              />
              Behind the conversation
            </button>
            <a
              href={`/session/${sessionId}`}
              target="_blank"
              rel="noreferrer"
              class="ml-auto inline-flex min-h-9 items-center gap-1 text-accent hover:underline"
            >
              Open full conversation <NeoIcon name="external" class="!h-3.5 !w-3.5" />
            </a>
          </div>
          {expanded && (
            <div id="neo-conversation-details" class="mt-3 rounded-xl border border-line p-3">
              {messages.map((message) => (
                <SDKMessageRenderer
                  key={message.uuid}
                  message={message}
                  sessionId={sessionId}
                  {...maps}
                  resolvedQuestions={resolved}
                  pendingQuestion={null}
                  isRunning={store.isWorking.value}
                />
              ))}
              <button
                type="button"
                onClick={() => {
                  setExpanded(false);
                  toggle.current?.focus();
                  toggle.current?.scrollIntoView({ block: 'nearest' });
                }}
                class="mt-4 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-line bg-fill-soft hover:text-fg"
              >
                <NeoIcon name="chevron" class="!h-4 !w-4" /> Close details
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
