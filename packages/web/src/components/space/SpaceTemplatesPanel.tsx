import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { useEffect, useState } from 'preact/hooks';
import { groupTemplatesByLabel } from './template-grouping';
import { TemplateCard } from './TemplateCard';
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
  templateInstanceCounts,
  userTemplateKeys,
  onUseTemplate,
}: {
  spaceId: string;
  templates: SpaceLongHorizonAgentTemplate[];
  templateInstanceCounts: Map<string, number>;
  userTemplateKeys: ReadonlySet<string>;
  onUseTemplate: (template: SpaceLongHorizonAgentTemplate) => void;
}) {
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<SpaceLongHorizonAgentTemplate | null>(
    null
  );
  const templateGroups = groupTemplatesByLabel(templates);
  const pendingDelete = templateDeleteRequest.value;

  useEffect(() => {
    return () => abandonIdleTemplateDelete(spaceId);
  }, [spaceId]);

  return (
    <>
      <section>
        <div class="mb-3 flex items-end justify-between gap-3">
          <div>
            <h3 class="text-lg font-semibold tracking-tight text-fg">
              Templates · <span data-testid="agent-template-count">{templates.length}</span>
            </h3>
            <p class="mt-0.5 text-xs text-fg-faint">
              Add a focused role with preconfigured instructions.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditingTemplate(null);
              setShowTemplateEditor(true);
            }}
            class="text-xs font-medium text-accent-soft/85 underline-offset-4 transition-colors hover:text-accent-soft hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            New Template
          </button>
        </div>
        <div class="space-y-5">
          {templateGroups.map((group) => (
            <div key={group.key} data-testid={`agent-template-group-${group.key}`}>
              <h4 class="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-fg-muted">
                {group.title} · {group.templates.length}
              </h4>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.templates.map((t) => (
                  <TemplateCard
                    key={t.key}
                    template={t}
                    addedCount={templateInstanceCounts.get(t.key) ?? 0}
                    isUserTemplate={userTemplateKeys.has(t.key)}
                    onClick={() => onUseTemplate(t)}
                    onEdit={() => {
                      setEditingTemplate(t);
                      setShowTemplateEditor(true);
                    }}
                    onDelete={() => openTemplateDelete(spaceId, t)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

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
