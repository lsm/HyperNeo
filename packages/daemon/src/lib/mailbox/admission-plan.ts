import { createHash } from 'node:crypto';
import type { ReferenceMetadata } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { MessageDeliveryOrigin } from '../agent/message-delivery.ts';
import { mailboxMessageIsSynthetic, type MailboxEntry } from './entry.ts';
import { decodeUlidTimestamp } from './ulid.ts';

export type SessionMailboxEntry = MailboxEntry & {
  to: { kind: 'session'; sessionId: string };
};

type AdmissionMessage = SDKUserMessage & {
  uuid: NonNullable<SDKUserMessage['uuid']>;
  referenceMetadata?: ReferenceMetadata;
};

export interface MailboxAdmissionPlan {
  sessionId: string;
  message: AdmissionMessage;
  origin?: 'system';
  hold?: 'manual';
  materializeOnly?: true;
  delivery: {
    origin: MessageDeliveryOrigin;
    parentToolUseId: null;
    admittedAt: number;
    admissionRowid?: number;
  };
}

function deterministicUuid(entryId: string): AdmissionMessage['uuid'] {
  const digest = createHash('sha256').update(entryId).digest('hex');
  return `mbox-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}` as AdmissionMessage['uuid'];
}

export function projectAdmissionMessage(
  entry: SessionMailboxEntry,
  synthetic: boolean
): AdmissionMessage {
  const uuid = entry.messageUuid ?? deterministicUuid(entry.id);
  return {
    ...entry.message,
    uuid: uuid as AdmissionMessage['uuid'],
    session_id: entry.to.sessionId,
    ...(synthetic ? { isSynthetic: true } : {}),
  };
}

export function projectAdmissionDelivery(
  entry: SessionMailboxEntry,
  admissionRowid: number | undefined
): MailboxAdmissionPlan['delivery'] {
  const origin = entry.origin;
  return {
    origin:
      origin === 'chat' ||
      origin === 'space_inject' ||
      origin === 'space_agent' ||
      origin === 'long_term_agent' ||
      origin === 'recovery'
        ? origin
        : 'space_inject',
    parentToolUseId: null,
    admittedAt: decodeUlidTimestamp(entry.id),
    ...(admissionRowid !== undefined ? { admissionRowid } : {}),
  };
}

export function assembleAdmissionPlan(
  entry: SessionMailboxEntry,
  synthetic: boolean,
  message: AdmissionMessage,
  delivery: MailboxAdmissionPlan['delivery']
): MailboxAdmissionPlan {
  return {
    sessionId: entry.to.sessionId,
    message,
    ...(synthetic ? { origin: 'system' as const } : {}),
    ...(entry.deliveryMode === 'defer'
      ? { hold: 'manual' as const, materializeOnly: true as const }
      : {}),
    delivery,
  };
}

function admissionIsSynthetic(entry: SessionMailboxEntry): boolean {
  return mailboxMessageIsSynthetic(entry.origin, entry.message);
}

export const planMailboxAdmission = (superpipe({})('mailbox-admission-plan') as PipelineAPI)
  .input(['entry', 'admissionRowid'])
  .pipe(admissionIsSynthetic, 'entry', 'synthetic')
  .pipe(projectAdmissionMessage, ['entry', 'synthetic'], 'message')
  .pipe(projectAdmissionDelivery, ['entry', 'admissionRowid'], 'delivery')
  .pipe(assembleAdmissionPlan, ['entry', 'synthetic', 'message', 'delivery'], 'plan')
  .end('plan') as (entry: SessionMailboxEntry, admissionRowid?: number) => MailboxAdmissionPlan;
