import type { Session } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { durablePromptUuid } from '../agent/retry-prompt-identity.ts';
import { Logger } from '../logger.ts';
import { isDefiniteOapRefusal, OapHubRequestError } from './oap-hub-client.ts';
import { announceOapNotice } from './oap-notice.ts';
import type { OapQueryHub } from './oap-query.ts';
import type { OapReopenEvents, OapReopenStore } from './oap-reopen.ts';

type Recovery = NonNullable<Session['metadata']['oapRecovery']>;
const logger = new Logger('OapRecovery');

export function recoveryContext(messages: unknown[]): string {
  const rows = messages as Array<{
    type: string;
    subtype?: string;
    is_error?: boolean;
    deliveryStatus?: string;
    message?: { content?: unknown };
  }>;
  const terminal = rows.findLastIndex(
    (item) => item.type === 'result' && item.subtype === 'success' && item.is_error === false
  );
  return rows
    .slice(0, terminal + 1)
    .flatMap((item) => {
      if (
        !['user', 'assistant'].includes(item.type) ||
        (item.type === 'user' && item.deliveryStatus !== 'delivered')
      )
        return [];
      const content = item.message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((part) => part?.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text)
                .join('')
            : '';
      return text ? [`${item.type}: ${text}`] : [];
    })
    .join('\n')
    .slice(-12000);
}

function recoveryMessage(message: SDKUserMessage, recovery: Recovery): SDKUserMessage {
  const prefix = `Previous conversation excerpt (the earlier thread could not be resumed):\n${recovery.text}\n\nCurrent request:\n`;
  const content = message.message.content;
  if (
    typeof content !== 'string' &&
    (!Array.isArray(content) ||
      content.some((part) => part.type !== 'text' || typeof part.text !== 'string'))
  ) {
    throw new OapHubRequestError('invalid_submission', 'OAP currently supports text input only');
  }
  return {
    ...message,
    message: {
      ...message.message,
      content:
        typeof content === 'string'
          ? prefix + content
          : [{ type: 'text', text: prefix }, ...content],
    },
  };
}

const prepareRecovery = (superpipe({})('oap.recovery.message') as PipelineAPI)
  .input(['message', 'recovery'])
  .pipe(recoveryMessage, ['message', 'recovery'], 'prepared')
  .end('prepared') as (message: SDKUserMessage, recovery: Recovery) => SDKUserMessage;

function sameRecovery(left: Recovery | undefined, right: Recovery): boolean {
  return (
    !!left &&
    left.previous === right.previous &&
    left.text === right.text &&
    left.pendingOpen === right.pendingOpen &&
    left.claim === right.claim
  );
}

async function writeRecovery(
  sessionId: string,
  getSession: () => Session,
  db: OapReopenStore,
  expected: Recovery,
  next: Recovery | undefined
): Promise<boolean> {
  const session = getSession();
  if (!sameRecovery(session.metadata?.oapRecovery, expected)) return false;
  const metadata = { ...session.metadata, oapRecovery: next };
  if ((await db.updateSession(sessionId, { metadata })) !== 'written')
    throw new Error('Could not save the Codex recovery claim');
  if (sameRecovery(session.metadata?.oapRecovery, expected)) session.metadata = metadata;
  const latest = getSession();
  if (latest !== session && sameRecovery(latest.metadata?.oapRecovery, expected))
    latest.metadata = { ...latest.metadata, oapRecovery: next };
  return true;
}

export function withOapRecovery(
  hub: OapQueryHub,
  getSession: () => Session,
  db: OapReopenStore,
  messageHub: OapReopenEvents
): OapQueryHub {
  let pending: { owner?: symbol; cancelled: boolean } | undefined;
  const noticeUnknown = async (message: SDKUserMessage, owner?: symbol, isLive?: () => boolean) => {
    const session = getSession();
    if (
      !session.metadata?.oapRecovery?.claim ||
      session.metadata.oapRecovery.claim !== durablePromptUuid(message)
    )
      return;
    const attempt = { owner, cancelled: false };
    pending = attempt;
    try {
      await announceOapNotice(
        session.id,
        'Codex recovery was already submitted; outcome may be unknown',
        db,
        messageHub,
        () => {
          if (attempt.cancelled || (isLive && !isLive()))
            throw new Error('OAP recovery attempt expired');
        }
      );
    } finally {
      if (pending === attempt) pending = undefined;
    }
  };
  return {
    ...hub,
    reportAdmissionFailure: noticeUnknown,
    release(owner) {
      if (pending && (!owner || pending.owner === owner)) pending.cancelled = true;
      hub.release?.(owner);
    },
    async submit(sessionId, message, owner, isLive) {
      if (pending) throw new Error('OAP query hub is not available for submission');
      const recovery = getSession().metadata?.oapRecovery;
      const deliveryUuid = durablePromptUuid(message);
      const forward = (prepared: SDKUserMessage) =>
        isLive
          ? hub.submit(sessionId, prepared, owner, isLive)
          : hub.submit(sessionId, prepared, owner);
      if (!recovery) return hub.submit(sessionId, message, owner);
      if (recovery.pendingOpen)
        throw new OapHubRequestError('invalid_submission', 'Codex recovery is still opening');
      if (recovery.claim) {
        if (recovery.claim === deliveryUuid) {
          const text = 'Codex recovery was already submitted; outcome may be unknown';
          await noticeUnknown(message, owner, isLive);
          throw new OapHubRequestError('outcome_unknown', text);
        }
        return forward(message);
      }
      const internal = (message as SDKUserMessage & { internal?: boolean }).internal;
      if (internal) return forward(message);
      const input =
        deliveryUuid && db.getSDKMessageRepo().getDeliveryContent(sessionId, deliveryUuid);
      if (!input)
        throw new OapHubRequestError(
          'invalid_submission',
          'Cannot identify the Codex recovery input'
        );
      if (input.isSynthetic || (input.inputKind && input.inputKind !== 'human'))
        return forward(message);
      const prepared = prepareRecovery(message, recovery);
      const attempt = { owner, cancelled: false };
      pending = attempt;
      const claimed = { ...recovery, claim: deliveryUuid! };
      try {
        try {
          if (!(await writeRecovery(sessionId, getSession, db, recovery, claimed)))
            throw new Error('Recovery changed before claiming');
        } catch (error) {
          logger.warn('Failed to persist Codex recovery claim:', error);
          throw new OapHubRequestError(
            'invalid_submission',
            'Could not save the Codex recovery claim'
          );
        }
        if (attempt.cancelled || (isLive && !isLive())) {
          try {
            await writeRecovery(sessionId, getSession, db, claimed, recovery);
          } catch (cause) {
            logger.error('Could not restore Codex recovery context', cause);
            throw new OapHubRequestError(
              'invalid_submission',
              'OAP recovery submission was closed; could not restore recovery context'
            );
          }
          throw new OapHubRequestError('invalid_submission', 'OAP recovery submission was closed');
        }
        pending = undefined;
        let accepted: { runId: string };
        try {
          accepted = await forward(prepared);
        } catch (error) {
          if (isDefiniteOapRefusal(error)) {
            try {
              await writeRecovery(sessionId, getSession, db, claimed, recovery);
            } catch (cause) {
              logger.error('Could not restore Codex recovery context', cause);
              throw new OapHubRequestError(
                error.code,
                `${error.message}; could not restore recovery context`,
                error.feature
              );
            }
          }
          throw error;
        }
        try {
          await writeRecovery(sessionId, getSession, db, claimed, undefined);
        } catch (error) {
          logger.error('Could not clear Codex recovery context', error);
          const latest = getSession();
          if (sameRecovery(latest.metadata?.oapRecovery, claimed))
            latest.metadata = { ...latest.metadata, oapRecovery: undefined };
        }
        return accepted;
      } finally {
        if (pending === attempt) pending = undefined;
      }
    },
  };
}
