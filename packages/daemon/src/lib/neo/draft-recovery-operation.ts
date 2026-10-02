import { DRAFT_CHAR_LIMIT } from '@hyperneo/shared';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SessionInputDraftSnapshot } from '../../storage/repositories/session-input-draft-write.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoService } from './service.ts';

const Input = z
  .object({
    sessionId: z.string().startsWith('neo:').max(200),
    text: z.string().max(DRAFT_CHAR_LIMIT),
    base: z.string().max(DRAFT_CHAR_LIMIT).nullable(),
  })
  .strict();
type Recovery = z.infer<typeof Input>;
type Reason = 'human_only' | 'session_not_found' | 'superseded' | 'submitted' | 'invalid';
type Refusal = { ok: false; reason: Reason };
type Result = Refusal | { ok: true; notified: boolean };
type Gate<T> = { value: T } | { reason: Refusal };
type Recovers = Pick<NeoService, 'repo' | 'asks' | 'sessions'>;
type Captured = { recovery: Recovery; snapshot: SessionInputDraftSnapshot };

const refuse = (reason: Reason): { reason: Refusal } => ({ reason: { ok: false, reason } });

export function requireDraftRecoveryHuman(
  recovery: Recovery,
  caller: OperationCaller
): Gate<Recovery> {
  return caller.source === 'rpc' && caller.principal === 'local'
    ? { value: recovery }
    : refuse('human_only');
}

export function captureRecoverableDraft(recovery: Recovery, service: Recovers): Gate<Captured> {
  const binding = service.repo.getBindingBySession(recovery.sessionId);
  if (!binding || binding.kind === 'worker') return refuse('session_not_found');
  const snapshot = service.sessions.captureInputDraft(recovery.sessionId);
  return snapshot ? { value: { recovery, snapshot } } : refuse('session_not_found');
}

export function requireUnchangedBase(captured: Captured): Gate<Captured> {
  return (captured.snapshot.draft || null) === (captured.recovery.base || null)
    ? { value: captured }
    : refuse('superseded');
}

function askText(ask: NeoConversationAsk): string {
  if (typeof ask.content === 'string') return ask.content.trim();
  const blocks: readonly { type: string; text?: unknown }[] = ask.content;
  return blocks
    .flatMap((block) =>
      block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    )
    .join('\n')
    .trim();
}

export function requireUnsubmitted(captured: Captured, service: Recovers): Gate<Captured> {
  const root = service.repo.getBindingForConcern(null);
  if (!root?.sessionId.startsWith('neo:')) return refuse('session_not_found');
  const newest = service.asks.newestFrom(root.sessionId.slice(4), captured.recovery.sessionId);
  return newest && askText(newest) === captured.recovery.text.trim()
    ? refuse('submitted')
    : { value: captured };
}

async function commitRecoveredDraft(captured: Captured, service: Recovers): Promise<Result> {
  const outcome = await service.sessions.updateInputDraftIf(
    captured.snapshot,
    captured.recovery.text.trim() || null
  );
  return outcome.kind === 'won'
    ? { ok: true, notified: outcome.notified }
    : { ok: false, reason: outcome.kind };
}

const recover = (superpipe({})('neo-draft-recover') as PipelineAPI)
  .input(['recovery', 'caller', 'service'])
  .pipe(requireDraftRecoveryHuman, ['recovery', 'caller'], 'result:draft')
  .pipe(captureRecoverableDraft, ['draft', 'service'], 'result:draft')
  .pipe(requireUnchangedBase, 'draft', 'result:draft')
  .pipe(requireUnsubmitted, ['draft', 'service'], 'result:draft')
  .pipe(commitRecoveredDraft, ['draft', 'service'], 'draft')
  .endAsync('draft') as (
  recovery: Recovery,
  caller: OperationCaller,
  service: Recovers
) => Promise<Result>;

export function createNeoDraftRecoveryOperation(service: Recovers) {
  return defineOperation({
    name: 'neo.draft.recover',
    description:
      'Re-save a Neo composer edit captured in this tab before a reload. Commits only when the saved draft still equals the base the edit started from and the edit is not the newest ask already sent from that session; never consumes staged voice. A refusal leaves the saved draft untouched.',
    policy: { safetyClass: 'human_only' },
    inputSchema: Input,
    resultSchema: z.union([
      z.object({
        ok: z.literal(false),
        reason: z.enum(['human_only', 'session_not_found', 'superseded', 'submitted', 'invalid']),
      }),
      z.object({ ok: z.literal(true), notified: z.boolean() }),
    ]),
    execute: async (recovery, caller) => recover(recovery, caller, service),
  });
}
