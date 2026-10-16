import {
  ChevronRightGlyph,
  ChevronDownGlyph,
  ChevronUpGlyph,
  CloseGlyph,
} from './common-glyphs.tsx';
import { cn } from '../../lib/utils.ts';

const outlineAttributes = { fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor' } as const;
const roundedPathAttributes = { 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

export function GitExternalLinkIcon() {
  return (
    <svg class="h-3.5 w-3.5" {...outlineAttributes}>
      <path
        {...roundedPathAttributes}
        stroke-width={1.8}
        d="M14 5h5v5M19 5l-8 8M12 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"
      />
    </svg>
  );
}

export function GitCheckSmallIcon() {
  return (
    <svg class="h-3.5 w-3.5 text-success-soft" {...outlineAttributes}>
      <path {...roundedPathAttributes} stroke-width={2.5} d="M4.5 12.75 10 18.25 19.5 6.5" />
    </svg>
  );
}

export function GitCopyIcon() {
  return (
    <svg class="h-3.5 w-3.5" {...outlineAttributes}>
      <path
        {...roundedPathAttributes}
        stroke-width={1.8}
        d="M8 8H6.5A1.5 1.5 0 0 0 5 9.5v8A1.5 1.5 0 0 0 6.5 19h8a1.5 1.5 0 0 0 1.5-1.5V16M9.5 5h8A1.5 1.5 0 0 1 19 6.5v8A1.5 1.5 0 0 1 17.5 16h-8A1.5 1.5 0 0 1 8 14.5v-8A1.5 1.5 0 0 1 9.5 5Z"
      />
    </svg>
  );
}

export function GitChevronIcon({ open }: { open: boolean }) {
  return (
    <ChevronRightGlyph
      class={cn('h-3 w-3 flex-shrink-0 text-fg-faint transition-transform', open && 'rotate-90')}
      {...outlineAttributes}
      pathProps={{ 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': 2.5 }}
    />
  );
}

export function GitDotIcon() {
  return (
    <svg class="h-3 w-3" {...outlineAttributes}>
      <circle cx="12" cy="12" r="3.5" stroke-width={2.5} />
    </svg>
  );
}

export function GitCheckDotIcon() {
  return (
    <svg class="h-3.5 w-3.5" {...outlineAttributes}>
      <path {...roundedPathAttributes} stroke-width={2.5} d="M4.5 12.75 10 18.25 19.5 6.5" />
    </svg>
  );
}

export function GitPendingIcon() {
  return (
    <svg class="h-5 w-5" {...outlineAttributes}>
      <path
        {...roundedPathAttributes}
        stroke-width={1.8}
        d="M12 6v6l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      />
    </svg>
  );
}

export function GitErrorIcon() {
  return (
    <svg class="h-5 w-5" {...outlineAttributes}>
      <path
        {...roundedPathAttributes}
        stroke-width={1.8}
        d="M12 8v4M12 16h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      />
    </svg>
  );
}

export function GitCommitIcon() {
  return (
    <svg class="h-5 w-5" {...outlineAttributes}>
      <path
        {...roundedPathAttributes}
        stroke-width={1.8}
        d="M4 12h6M14 12h6M10 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"
      />
    </svg>
  );
}

export function GitChecksIcon() {
  return (
    <svg class="h-5 w-5" {...outlineAttributes}>
      <path
        {...roundedPathAttributes}
        stroke-width={1.8}
        d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      />
    </svg>
  );
}

export function GitWorkspaceIcon() {
  return (
    <svg class="h-5 w-5" {...outlineAttributes}>
      <path
        {...roundedPathAttributes}
        stroke-width={1.8}
        d="M4.5 17.5h15M6.5 6.5h11a1 1 0 0 1 1 1v8.5h-13V7.5a1 1 0 0 1 1-1Z"
      />
    </svg>
  );
}

export function GitPullRequestIcon() {
  return (
    <svg class="h-5 w-5" {...outlineAttributes}>
      <path
        {...roundedPathAttributes}
        stroke-width={1.8}
        d="M7 5v14M17 5v3a4 4 0 0 1-4 4H7M17 5a2 2 0 1 0-4 0 2 2 0 0 0 4 0ZM9 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM19 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z"
      />
    </svg>
  );
}

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
