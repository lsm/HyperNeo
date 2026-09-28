import type { ChatMessage } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { SessionStore } from '../lib/session-store.ts';
import { NeoMessage } from './NeoMessage.tsx';
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

export function completedConversation(messages: ChatMessage[]): ChatMessage[] {
  const visible: ChatMessage[] = [];
  let reply: ChatMessage | null = null;
  for (const message of messages) {
    const text = conversationText(message);
    const syntheticDelivery = (message as { inputKind?: string }).inputKind === 'system';
    if (message.type === 'user' && text && !syntheticDelivery) visible.push(message);
    if (message.type === 'assistant' && text) reply = message;
    if (message.type === 'result') {
      if (reply) visible.push(reply);
      reply = null;
    }
  }
  return visible;
}

export function completedWorkReplies(
  messages: ChatMessage[],
  works: NeoWork[]
): Map<string, NeoWork> {
  const receipts = new Map<string, NeoWork>();
  for (const work of works) {
    if (!work.report) continue;
    receipts.set(work.id, work);
    receipts.set(`neo-consult:neo-work:${work.id}:review:reply`, work);
  }
  const replies = new Map<string, NeoWork>();
  let active: NeoWork | null = null;
  let reply: ChatMessage | null = null;
  for (const message of messages) {
    if (message.type === 'user' && !message.parent_tool_use_id) {
      active =
        (message as { inputKind?: string }).inputKind === 'system'
          ? (receipts.get(message.uuid ?? '') ?? null)
          : null;
    }
    if (message.type === 'assistant' && conversationText(message)) reply = message;
    if (message.type === 'result') {
      if (active && reply?.uuid) replies.set(reply.uuid, active);
      active = null;
      reply = null;
    }
  }
  return replies;
}

const activityLabels: Record<string, string> = {
  'neo.snapshot': 'Checked what Neo knows',
  'neo.concern.consult': 'Checked with a context holder',
  'neo.concern.save': 'Saved continuing context',
  'neo.work.propose': 'Prepared a work card',
  'neo.concern.respond': 'Returned a context check',
};

export function completedActivities(messages: ChatMessage[]): Map<string, string[]> {
  const activities = new Map<string, string[]>();
  let steps: string[] = [];
  let reply: ChatMessage | null = null;
  let origin: ChatMessage | null = null;
  for (const message of messages) {
    if (message.type === 'user' && conversationText(message)) {
      origin = message;
      steps = [];
      reply = null;
    }
    if (message.type === 'assistant') {
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== 'tool_use') continue;
          const tool = block as { name?: string; input?: { name?: string } };
          const label =
            tool.name === 'mcp__hyperneo-operations__invoke'
              ? (activityLabels[tool.input?.name ?? ''] ?? 'Used a HyperNeo capability')
              : 'Used a tool';
          if (!steps.includes(label)) steps.push(label);
        }
      }
      if (conversationText(message)) reply = message;
    }
    if (message.type === 'result') {
      if (reply?.uuid) {
        if ((origin as { inputKind?: string } | null)?.inputKind === 'system') {
          const label = origin?.uuid?.startsWith('neo-consult:')
            ? 'Received a context check'
            : 'Received delegated work';
          if (!steps.includes(label)) steps.push(label);
        }
        if (steps.length) activities.set(reply.uuid, steps);
      }
      origin = null;
      reply = null;
      steps = [];
    }
  }
  return activities;
}

export function NeoConversation({
  store,
  sessionId,
  works = [],
}: {
  store: SessionStore;
  sessionId: string;
  works?: NeoWork[];
}) {
  const messages = store.sdkMessages.value;
  const maps = useMessageMaps(messages, sessionId);
  const state = store.agentState.value;
  const pending = state.status === 'waiting_for_input' ? state.pendingQuestion : null;
  const conversation = messages.filter(
    (message) => !maps.replacementStatusMap.has(message.uuid ?? '')
  );
  const visible = completedConversation(conversation);
  const workReplies = completedWorkReplies(conversation, works);
  const activities = completedActivities(conversation);
  const progress =
    state.status === 'queued' || state.status === 'processing'
      ? state.status === 'queued' || state.phase === 'initializing'
        ? 'Neo is getting ready…'
        : 'Neo is working on a reply…'
      : state.status === 'rate_limit_cooldown'
        ? 'Neo is waiting to retry…'
        : null;
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
          <NeoMessage
            key={message.uuid}
            message={message}
            text={conversationText(message)}
            work={workReplies.get(message.uuid ?? '')}
            activity={activities.get(message.uuid ?? '')}
            sessionId={sessionId}
          />
        ))}
        {progress && (
          <div role="status" class="neo-progress" aria-live="polite">
            <span class="neo-progress-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>{progress}</span>
          </div>
        )}
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
    </>
  );
}
