import type { JSX } from 'preact';
import { memo } from 'preact/compat';
import { useState, useCallback, useRef } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import { useMessageHub } from '../../hooks/useMessageHub.ts';
import type { ReferenceType, ReferenceMetadata, ResolvedReference } from '@hyperneo/shared';
import { REFERENCE_PATTERN } from '@hyperneo/shared';

const TYPE_STYLES: Record<ReferenceType, { pill: string; label: string }> = {
  task: {
    pill: 'bg-accent-hover/20 text-cat-indigo border-indigo-500/40 hover:bg-accent-hover/30',
    label: 'task',
  },
  goal: {
    pill: 'bg-warning/20 text-warning border-warning/40 hover:bg-warning/30',
    label: 'goal',
  },
  file: {
    pill: 'bg-accent/20 text-accent-soft border-accent/40 hover:bg-accent/30',
    label: 'file',
  },
  folder: {
    pill: 'bg-warning/20 text-warning-soft border-warning/40 hover:bg-warning/30',
    label: 'folder',
  },
};

function renderResolvedContent(resolved: ResolvedReference): JSX.Element {
  switch (resolved.type) {
    case 'task':
    case 'goal': {
      const d = resolved.data as { title?: string; status?: string; description?: string };
      return (
        <div>
          {d.title && <div class="font-medium text-accent-fg">{d.title}</div>}
          {d.status && <div class="text-xs text-fg-muted mt-0.5">Status: {d.status}</div>}
          {d.description && (
            <div class="text-xs text-fg-muted mt-1 line-clamp-2">{d.description}</div>
          )}
        </div>
      );
    }
    case 'file': {
      const d = resolved.data as {
        path: string;
        size: number;
        binary: boolean;
        truncated: boolean;
      };
      return (
        <div>
          <div class="font-medium text-accent-fg font-mono text-xs truncate">{d.path}</div>
          <div class="text-xs text-fg-muted mt-0.5">
            {d.binary ? 'Binary file' : `${Math.round(d.size / 1024)} KB`}
            {d.truncated && ' (truncated)'}
          </div>
        </div>
      );
    }
    case 'folder': {
      const d = resolved.data as { path: string; entries: Array<{ name: string }> };
      return (
        <div>
          <div class="font-medium text-accent-fg font-mono text-xs truncate">{d.path}</div>
          <div class="text-xs text-fg-muted mt-0.5">{d.entries.length} entries</div>
        </div>
      );
    }
    default: {
      return <div class="text-xs text-fg-muted">Unknown reference type</div>;
    }
  }
}

export interface MentionTokenProps {
  refType: ReferenceType;
  id: string;
  displayText: string;
  status?: string;
  sessionId?: string;
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

interface PopoverPos {
  top: number;
  left: number;
  below: boolean;
}

function MentionTokenBase({ refType, id, displayText, status, sessionId }: MentionTokenProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [resolvedData, setResolvedData] = useState<ResolvedReference | null>(null);
  const [popoverPos, setPopoverPos] = useState<PopoverPos>({ top: 0, left: 0, below: false });
  const tokenRef = useRef<HTMLSpanElement>(null);
  const { callIfConnected } = useMessageHub();

  const typeStyle = TYPE_STYLES[refType];

  const isNotFound = status === 'not_found' || (loadState === 'loaded' && resolvedData === null);

  const handleMouseEnter = useCallback(async () => {
    if (tokenRef.current) {
      const rect = tokenRef.current.getBoundingClientRect();
      const below = rect.top < 160;
      setPopoverPos({ top: below ? rect.bottom : rect.top, left: rect.left, below });
    }
    setIsHovered(true);

    if (loadState === 'idle' && sessionId) {
      setLoadState('loading');
      try {
        const result = await callIfConnected<{ resolved: ResolvedReference | null }>(
          'reference.resolve',
          { sessionId, type: refType, id }
        );
        setResolvedData(result?.resolved ?? null);
        setLoadState('loaded');
      } catch {
        setLoadState('error');
      }
    }
  }, [loadState, sessionId, refType, id, callIfConnected]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
  }, []);

  const POPOVER_GAP = 6;

  return (
    <span class="inline-block align-baseline">
      <span
        ref={tokenRef}
        class={cn(
          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-xs font-medium cursor-default transition-colors',
          typeStyle.pill,
          isNotFound && 'opacity-50 line-through'
        )}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        data-testid="mention-token"
        data-ref-type={refType}
        data-ref-id={id}
        data-not-found={isNotFound ? 'true' : undefined}
      >
        <span class="opacity-60 text-[10px] uppercase tracking-wide">{typeStyle.label}</span>
        <span>{displayText}</span>
      </span>

      {isHovered && (
        <div
          style={{
            position: 'fixed',
            left: `${popoverPos.left}px`,
            top: popoverPos.below
              ? `${popoverPos.top + POPOVER_GAP}px`
              : `${popoverPos.top - POPOVER_GAP}px`,
            transform: popoverPos.below ? 'none' : 'translateY(-100%)',
            zIndex: 9999,
          }}
          class="min-w-[180px] max-w-[280px] bg-surface-raised border border-line-strong/50 rounded-md shadow-lg p-3 text-sm pointer-events-none animate-fadeIn"
          role="tooltip"
          data-testid="mention-token-popover"
        >
          {loadState === 'loading' && <div class="text-xs text-fg-muted">Loading...</div>}
          {loadState === 'loaded' && resolvedData && renderResolvedContent(resolvedData)}
          {loadState === 'loaded' && !resolvedData && (
            <div class="text-xs text-fg-muted">Not found</div>
          )}
          {loadState === 'error' && <div class="text-xs text-danger">Failed to load</div>}
          {loadState === 'idle' && (
            <div class="text-xs text-fg-muted">
              {refType}/{id}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

export const MentionToken = memo(MentionTokenBase);

export type TextSegment = { kind: 'text'; content: string };
export type MentionSegment = {
  kind: 'mention';
  raw: string;
  refType: ReferenceType;
  id: string;
  displayText: string;
  status?: string;
};
export type UnknownMentionSegment = { kind: 'unknown-mention'; content: string };
export type Segment = TextSegment | MentionSegment | UnknownMentionSegment;

const VALID_REF_TYPES: ReadonlySet<string> = new Set<string>([
  'task',
  'goal',
  'file',
  'folder',
] satisfies readonly ReferenceType[]);

export function parseTextWithReferences(text: string, metadata: ReferenceMetadata): Segment[] {
  const segments: Segment[] = [];
  const pattern = new RegExp(REFERENCE_PATTERN.source, REFERENCE_PATTERN.flags);
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0];
    const type = match[1];
    const id = match[2];
    const start = match.index;

    if (start > lastIndex) {
      segments.push({ kind: 'text', content: text.slice(lastIndex, start) });
    }

    if (VALID_REF_TYPES.has(type)) {
      const meta = metadata[raw];
      segments.push({
        kind: 'mention',
        raw,
        refType: type as ReferenceType,
        id,
        displayText: meta?.displayText ?? id,
        status: meta?.status,
      });
    } else {
      segments.push({ kind: 'unknown-mention', content: raw });
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: 'text', content: text.slice(lastIndex) });
  }

  return segments;
}
