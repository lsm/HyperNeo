import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { useEffect, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { groupTemplatesByLabel } from './template-grouping';
import { TemplateListItem } from './TemplateListItem';
import { TemplateDeleteDialog } from './TemplateDeleteDialog';
import { TemplateEditor } from './TemplateEditor';
import {
  abandonIdleTemplateDelete,
  closeTemplateDelete,
  openTemplateDelete,
  runTemplateDelete,
  templateDeleteRequest,
} from './template-delete-request';

export function SpaceTemplatesPanel({
  spaceId,
  templates,
  userTemplateKeys,
}: {
  spaceId: string;
  templates: SpaceLongHorizonAgentTemplate[];
  userTemplateKeys: ReadonlySet<string>;
}) {
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<SpaceLongHorizonAgentTemplate | null>(
    null
  );
  const [cloningTemplate, setCloningTemplate] = useState<SpaceLongHorizonAgentTemplate | null>(
    null
  );
  const templateGroups = groupTemplatesByLabel(templates);
  const pendingDelete = templateDeleteRequest.value;

  useEffect(() => {
    return () => abandonIdleTemplateDelete(spaceId);
  }, [spaceId]);

  const openNewTemplate = () => {
    setEditingTemplate(null);
    setShowTemplateEditor(true);
  };

  const openEditTemplate = (template: SpaceLongHorizonAgentTemplate) => {
    setEditingTemplate(template);
    setShowTemplateEditor(true);
  };

  const openCloneTemplate = (template: SpaceLongHorizonAgentTemplate) => {
    setCloningTemplate(template);
  };

  return (
    <>
      <div class="flex h-full min-h-0 flex-col overflow-hidden" data-testid="space-templates-panel">
        <div class="flat-surface mb-3 flex flex-shrink-0 flex-col items-stretch gap-3 rounded-xl p-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-soft">
              <span data-testid="agent-template-count">{templates.length}</span>{' '}
              {templates.length === 1 ? 'agent template' : 'agent templates'}
            </p>
            <p class="mt-1 text-xs leading-5 text-fg-muted">
              Reusable role presets — instructions, autonomy, model, and tools in one place. Agents
              created from a template inherit its configuration.
            </p>
          </div>
          <button
            type="button"
            onClick={openNewTemplate}
            class="glass-primary-button whitespace-nowrap !h-9 !px-3.5 !text-xs"
            data-testid="new-template-button"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            <span class="ml-1.5">New Template</span>
          </button>
        </div>

        <div class="scrollbar-dark min-h-0 flex-1 overflow-y-auto">
          {templates.length === 0 ? (
            <div class="flat-surface flex flex-col items-center justify-center rounded-xl py-12 text-center">
              <div class="w-10 h-10 mx-auto mb-3 rounded-lg bg-surface-raised border border-line flex items-center justify-center">
                <svg
                  class="w-5 h-5 text-fg-muted"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                  />
                </svg>
              </div>
              <p class="text-sm text-fg-muted">No templates yet</p>
              <p class="text-xs text-fg-muted mt-1">
                Create a template to give agents a repeatable starting configuration.
              </p>
              <button
                type="button"
                onClick={openNewTemplate}
                class="glass-primary-button mt-4 !h-9 !px-3.5 !text-xs"
              >
                Create your first template
              </button>
            </div>
          ) : (
            <div class="space-y-5">
              {templateGroups.map((group) => (
                <div key={group.key} data-testid={`agent-template-group-${group.key}`}>
                  <h4 class="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-muted">
                    {group.title} · {group.templates.length}
                  </h4>
                  <div class="flat-surface divide-y divide-line overflow-hidden rounded-xl">
                    {group.templates.map((t) => (
                      <TemplateListItem
                        key={t.key}
                        template={t}
                        isUserTemplate={userTemplateKeys.has(t.key)}
                        onEdit={userTemplateKeys.has(t.key) ? () => openEditTemplate(t) : undefined}
                        onDelete={
                          userTemplateKeys.has(t.key)
                            ? () => openTemplateDelete(spaceId, t)
                            : undefined
                        }
                        onClone={
                          userTemplateKeys.has(t.key) ? undefined : () => openCloneTemplate(t)
                        }
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showTemplateEditor && (
        <TemplateEditor
          template={editingTemplate}
          onSaved={() => {
            setShowTemplateEditor(false);
            setEditingTemplate(null);
          }}
          onCancel={() => {
            setShowTemplateEditor(false);
            setEditingTemplate(null);
          }}
        />
      )}

      {cloningTemplate && (
        <TemplateEditor
          template={null}
          cloneFrom={cloningTemplate}
          onSaved={() => setCloningTemplate(null)}
          onCancel={() => setCloningTemplate(null)}
        />
      )}

      {pendingDelete && pendingDelete.spaceId === spaceId && (
        <TemplateDeleteDialog
          template={pendingDelete.template}
          busy={pendingDelete.busy}
          error={pendingDelete.error}
          onConfirm={runTemplateDelete}
          onClose={closeTemplateDelete}
        />
      )}
    </>
  );
}

export function SpaceTemplatesSection({ spaceId }: { spaceId: string }) {
  const templates = spaceStore.agentTemplates.value;
  const userTemplateKeys = spaceStore.userTemplateKeys.value;

  useEffect(() => {
    spaceStore.ensureConfigData().catch(() => {});
  }, [spaceId]);

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden pt-4">
      <SpaceTemplatesPanel
        spaceId={spaceId}
        templates={templates}
        userTemplateKeys={userTemplateKeys}
      />
    </div>
  );
}
