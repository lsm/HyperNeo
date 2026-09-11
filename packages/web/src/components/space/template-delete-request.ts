import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { signal } from '@preact/signals';
import superpipe, { type PipelineAPI } from 'superpipe';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';

export interface TemplateDeleteRequest {
  spaceId: string;
  template: SpaceLongHorizonAgentTemplate;
  busy: boolean;
  error: string | null;
}

export type TemplateDeleteDecision =
  | { kind: 'run'; request: TemplateDeleteRequest }
  | { kind: 'skip'; reason: 'no-request' | 'already-running' | 'space-changed' };

type DeleteGate = { value: TemplateDeleteRequest } | { reason: TemplateDeleteDecision };

export const templateDeleteRequest = signal<TemplateDeleteRequest | null>(null);

export function gateRequestPresent(request: TemplateDeleteRequest | null): DeleteGate {
  if (!request) return { reason: { kind: 'skip', reason: 'no-request' } };
  return { value: request };
}

export function gateNotRunning(request: TemplateDeleteRequest): DeleteGate {
  if (request.busy) return { reason: { kind: 'skip', reason: 'already-running' } };
  return { value: request };
}

export function gateSpaceStillActive(
  request: TemplateDeleteRequest,
  activeSpaceId: string | null
): DeleteGate {
  if (request.spaceId !== activeSpaceId) {
    return { reason: { kind: 'skip', reason: 'space-changed' } };
  }
  return { value: request };
}

export function toRunDecision(request: TemplateDeleteRequest): TemplateDeleteDecision {
  return { kind: 'run', request };
}

export const decideTemplateDelete = (superpipe({})('template-delete') as PipelineAPI)
  .input(['request', 'activeSpaceId'])
  .pipe(gateRequestPresent, 'request', 'result:decided')
  .pipe(gateNotRunning, 'decided', 'result:decided')
  .pipe(gateSpaceStillActive, ['decided', 'activeSpaceId'], 'result:decided')
  .pipe(toRunDecision, 'decided', 'decided')
  .end('decided') as (
  request: TemplateDeleteRequest | null,
  activeSpaceId: string | null
) => TemplateDeleteDecision;

export function openTemplateDelete(spaceId: string, template: SpaceLongHorizonAgentTemplate): void {
  if (templateDeleteRequest.value?.busy) return;
  templateDeleteRequest.value = { spaceId, template, busy: false, error: null };
}

export function closeTemplateDelete(): void {
  if (templateDeleteRequest.value?.busy) return;
  templateDeleteRequest.value = null;
}

export function abandonIdleTemplateDelete(spaceId: string): void {
  const pending = templateDeleteRequest.value;
  if (!pending || pending.busy || pending.spaceId !== spaceId) return;
  templateDeleteRequest.value = null;
}

export async function runTemplateDelete(): Promise<void> {
  const decision = decideTemplateDelete(templateDeleteRequest.value, spaceStore.spaceId.value);
  if (decision.kind === 'skip') return;
  const pending = decision.request;
  templateDeleteRequest.value = { ...pending, busy: true, error: null };
  try {
    await spaceStore.deleteTemplate(pending.template.key, pending.template.version);
    toast.success(`"${pending.template.displayName}" deleted`);
    templateDeleteRequest.value = null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete template';
    templateDeleteRequest.value = { ...pending, busy: false, error: message };
    toast.error(`Could not delete "${pending.template.displayName}": ${message}`);
  }
}
