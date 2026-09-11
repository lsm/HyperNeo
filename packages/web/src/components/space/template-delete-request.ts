import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { signal } from '@preact/signals';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';

export interface TemplateDeleteRequest {
  spaceId: string;
  template: SpaceLongHorizonAgentTemplate;
  busy: boolean;
  error: string | null;
}

export const templateDeleteRequest = signal<TemplateDeleteRequest | null>(null);

export function openTemplateDelete(spaceId: string, template: SpaceLongHorizonAgentTemplate): void {
  if (templateDeleteRequest.value?.busy) return;
  templateDeleteRequest.value = { spaceId, template, busy: false, error: null };
}

export function closeTemplateDelete(): void {
  if (templateDeleteRequest.value?.busy) return;
  templateDeleteRequest.value = null;
}

export async function runTemplateDelete(): Promise<void> {
  const pending = templateDeleteRequest.value;
  if (!pending || pending.busy) return;
  templateDeleteRequest.value = { ...pending, busy: true, error: null };
  try {
    await spaceStore.deleteTemplate(pending.template.key, pending.template.version);
    toast.success(`"${pending.template.displayName}" deleted`);
    templateDeleteRequest.value = null;
  } catch (err) {
    templateDeleteRequest.value = {
      ...pending,
      busy: false,
      error: err instanceof Error ? err.message : 'Failed to delete template',
    };
  }
}
