import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';

export function TemplateCard({
  template,
  addedCount,
  isUserTemplate,
  onClick,
  onEdit,
  onDelete,
}: {
  template: SpaceLongHorizonAgentTemplate;
  addedCount: number;
  isUserTemplate: boolean;
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const addedCountBadge =
    addedCount > 0 ? (
      <span class="flex-shrink-0 rounded bg-fill-soft px-1.5 py-0.5 text-xs text-fg-muted">
        ×{addedCount}
      </span>
    ) : null;
  return (
    <div class="group flex min-h-28 items-start gap-2 rounded-xl border border-line bg-surface-overlay/85 px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all hover:-translate-y-0.5 hover:border-blue-400/30 hover:bg-surface-raised/95">
      <button
        type="button"
        onClick={onClick}
        class="min-w-0 flex-1 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <span class="text-sm font-semibold tracking-tight text-fg">{template.displayName}</span>
          {!isUserTemplate && (
            <span class="flex-shrink-0 rounded-full border border-line bg-fill-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
              Built-in
            </span>
          )}
        </div>
        <p class="mt-1.5 line-clamp-2 text-sm leading-relaxed text-fg-soft">
          {template.description}
        </p>
      </button>
      {isUserTemplate ? (
        <div class="flex flex-shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          {addedCountBadge}
          <button
            type="button"
            onClick={onEdit}
            class="rounded-md p-1.5 text-fg-faint transition-colors hover:bg-fill-soft hover:text-fg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            title="Edit template"
            aria-label={`Edit template ${template.displayName}`}
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={onDelete}
            class="rounded-md p-1.5 text-fg-faint transition-colors hover:bg-fill-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
            title="Delete template"
            aria-label={`Delete template ${template.displayName}`}
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </button>
        </div>
      ) : (
        (addedCountBadge ?? (
          <svg
            class="w-3.5 h-3.5 flex-shrink-0 text-fg-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
        ))
      )}
    </div>
  );
}
