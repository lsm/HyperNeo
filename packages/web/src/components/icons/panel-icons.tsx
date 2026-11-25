import { ChevronDownGlyph, ChevronUpGlyph, CloseGlyph } from './common-glyphs.tsx';

const outlineAttributes = { fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor' } as const;
const roundedPathAttributes = { 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

export function ModelPencilIcon() {
  return (
    <svg class="w-4 h-4 text-fg-muted" {...outlineAttributes}>
      <path
        {...roundedPathAttributes}
        stroke-width="2"
        d="M15.232 5.232l3.536 3.536M9 11l6.536-6.536a2 2 0 012.828 2.828L11.828 13.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z"
      />
    </svg>
  );
}

export function ModelPlusIcon() {
  return (
    <svg class="w-4 h-4" {...outlineAttributes}>
      <path {...roundedPathAttributes} stroke-width="2" d="M12 4v16m8-8H4" />
    </svg>
  );
}

export function ModelXIcon({ class: cls }: { class?: string }) {
  return <CloseGlyph class={cls ?? 'w-4 h-4 text-fg-muted'} {...outlineAttributes} />;
}

export function ModelChevronDownIcon() {
  return <ChevronDownGlyph class="w-4 h-4 text-fg-muted" {...outlineAttributes} />;
}

export function ModelChevronUpIcon() {
  return <ChevronUpGlyph class="w-4 h-4 text-fg-muted" {...outlineAttributes} />;
}

export function QueueMoveToNextIcon() {
  return (
    <svg class="h-3.5 w-3.5" {...outlineAttributes} stroke-width={2.3}>
      <path {...roundedPathAttributes} d="M12 5v14" />
      <path {...roundedPathAttributes} d="M19 12l-7 7-7-7" />
    </svg>
  );
}

export function QueueMoveToSteerIcon() {
  return (
    <svg class="h-3.5 w-3.5" {...outlineAttributes} stroke-width={2.3}>
      <path {...roundedPathAttributes} d="M12 19V5" />
      <path {...roundedPathAttributes} d="M5 12l7-7 7 7" />
    </svg>
  );
}

export function QueueTrashIcon() {
  return (
    <svg class="h-3.5 w-3.5" {...outlineAttributes} stroke-width={2}>
      <path {...roundedPathAttributes} d="M3 6h18" />
      <path {...roundedPathAttributes} d="M8 6V4h8v2" />
      <path {...roundedPathAttributes} d="M6.5 6l1 16h9l1-16" />
      <path {...roundedPathAttributes} d="M10 11v6M14 11v6" />
    </svg>
  );
}
