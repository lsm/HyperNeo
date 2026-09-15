import { render } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { resolvedTheme } from '../../lib/theme.ts';
import { setupFocusTrap } from '../ui/Modal.tsx';

let mermaidModulePromise: Promise<typeof import('mermaid').default> | null = null;
let mermaidInitializedTheme: 'dark' | 'default' | null = null;

export function getMermaidForTheme(theme: 'dark' | 'default') {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid')
      .then((module) => module.default)
      .catch((error) => {
        mermaidModulePromise = null;
        throw error;
      });
  }
  return mermaidModulePromise.then((mermaid) => {
    if (mermaidInitializedTheme !== theme) {
      mermaid.initialize({ startOnLoad: false, theme, layout: 'dagre', look: 'classic' });
      mermaidInitializedTheme = theme;
    }
    return mermaid;
  });
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 20;
const ZOOM_STEP = 1.25;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const FIT_PADDING = 48;

type DiagramTransform = { scale: number; x: number; y: number };
type DiagramSize = { width: number; height: number };
type PointerPoint = { x: number; y: number };
type PinchState = {
  firstId: number;
  secondId: number;
  distance: number;
  midX: number;
  midY: number;
} & DiagramTransform;

const clampScale = (scale: number, minScale: number) =>
  Math.min(MAX_SCALE, Math.max(minScale, scale));

const overlayButtonClass =
  'inline-flex h-10 w-10 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-fill-strong hover:text-fg';

let viewerRoot: HTMLDivElement | null = null;

function closeMermaidViewer() {
  if (!viewerRoot) return;
  render(null, viewerRoot);
  viewerRoot.remove();
  viewerRoot = null;
}

export function openMermaidViewer(source: string) {
  if (!viewerRoot) {
    viewerRoot = document.createElement('div');
    document.body.appendChild(viewerRoot);
  }
  render(<MermaidViewerOverlay source={source} onClose={closeMermaidViewer} />, viewerRoot);
}

export function MermaidFigureToolbar({ source }: { source: string }) {
  return (
    <div class="mermaid-figure-toolbar flex items-center rounded-md border border-line bg-surface/90 p-0.5 shadow-sm">
      <button
        type="button"
        title="Expand diagram"
        aria-label="Expand diagram"
        onClick={() => openMermaidViewer(source)}
        class="inline-flex h-10 w-10 items-center justify-center rounded text-fg-muted transition-colors hover:bg-fill-strong hover:text-fg"
      >
        <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"
          />
        </svg>
      </button>
    </div>
  );
}

export function MermaidViewerOverlay({ source, onClose }: { source: string; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, PointerPoint>());
  const panRef = useRef<PointerPoint | null>(null);
  const pinchRef = useRef<PinchState | null>(null);
  const fitScaleRef = useRef(1);
  const [size, setSize] = useState<DiagramSize>({ width: 0, height: 0 });
  const [fitScale, setFitScale] = useState(1);
  const [ready, setReady] = useState(false);
  const [transform, setTransform] = useState<DiagramTransform>({ scale: 1, x: 0, y: 0 });
  const theme = resolvedTheme.value;

  useEffect(() => {
    let cancelled = false;
    const host = contentRef.current;
    if (!host) return;
    host.innerHTML = '';
    setReady(false);
    const node = document.createElement('div');
    node.className = 'mermaid';
    node.textContent = source;
    host.appendChild(node);
    getMermaidForTheme(theme === 'dark' ? 'dark' : 'default')
      .then((mermaid) => mermaid.run({ nodes: [node] }))
      .then(() => {
        if (cancelled || !node.isConnected) return;
        const svg = node.querySelector('svg');
        const viewBox = svg?.getAttribute('viewBox')?.match(/-?[\d.]+/g);
        if (svg && viewBox && viewBox.length >= 4) {
          const width = Number.parseFloat(viewBox[2]);
          const height = Number.parseFloat(viewBox[3]);
          if (width > 0 && height > 0) {
            svg.style.maxWidth = 'none';
            svg.setAttribute('width', String(width));
            svg.setAttribute('height', String(height));
            svg.style.display = 'block';
            setSize((current) =>
              current.width === width && current.height === height ? current : { width, height }
            );
          }
        }
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        node.textContent = source;
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source, theme]);

  const fitToStage = useCallback(() => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scale =
      size.width > 0 && size.height > 0 && rect.width > FIT_PADDING && rect.height > FIT_PADDING
        ? Math.min(
            MAX_SCALE,
            (rect.width - FIT_PADDING) / size.width,
            (rect.height - FIT_PADDING) / size.height
          )
        : 1;
    fitScaleRef.current = scale;
    setFitScale(scale);
    setTransform({
      scale,
      x: size.width > 0 ? (rect.width - size.width * scale) / 2 : FIT_PADDING / 2,
      y: size.height > 0 ? (rect.height - size.height * scale) / 2 : FIT_PADDING / 2,
    });
  }, [size]);

  useLayoutEffect(() => {
    fitToStage();
  }, [fitToStage]);

  useEffect(() => {
    const handleResize = () => fitToStage();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [fitToStage]);

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    setTransform((current) => {
      const scale = clampScale(current.scale * factor, Math.min(MIN_SCALE, fitScaleRef.current));
      const ratio = scale / current.scale;
      return {
        scale,
        x: px - (px - current.x) * ratio,
        y: py - (py - current.y) * ratio,
      };
    });
  }, []);

  const zoomBy = (factor: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY));
    };
    stage.addEventListener('wheel', handleWheel, { passive: false });
    return () => stage.removeEventListener('wheel', handleWheel);
  }, [zoomAt]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handleKeydown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeydown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (trigger && trigger.isConnected) trigger.focus();
    };
  }, []);

  useEffect(() => {
    if (rootRef.current) {
      return setupFocusTrap(rootRef.current);
    }
  }, []);

  const rebasePinch = (pointers: Map<number, PointerPoint>) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const entries = Array.from(pointers.entries());
    if (entries.length < 2) return;
    const [firstEntry, secondEntry] = entries;
    const first = firstEntry[1];
    const second = secondEntry[1];
    const pinch = pinchRef.current;
    if (pinch && pinch.firstId === firstEntry[0] && pinch.secondId === secondEntry[0]) return;
    pinchRef.current = {
      firstId: firstEntry[0],
      secondId: secondEntry[0],
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      midX: (first.x + second.x) / 2 - rect.left,
      midY: (first.y + second.y) / 2 - rect.top,
      scale: transform.scale,
      x: transform.x,
      y: transform.y,
    };
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    try {
      stageRef.current?.setPointerCapture(event.pointerId);
    } catch {}
    const pointers = pointersRef.current;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) {
      rebasePinch(pointers);
      panRef.current = null;
    } else if (pointers.size === 1) {
      panRef.current = { x: event.clientX, y: event.clientY };
    }
  };

  const handlePointerMove = (event: PointerEvent) => {
    const pointers = pointersRef.current;
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;
    if (pointers.size >= 2) {
      const pinch = pinchRef.current;
      const rect = stageRef.current?.getBoundingClientRect();
      if (!pinch || !rect || pinch.distance <= 0) return;
      const [first, second] = Array.from(pointers.values());
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const midX = (first.x + second.x) / 2 - rect.left;
      const midY = (first.y + second.y) / 2 - rect.top;
      const scale = clampScale(
        pinch.scale * (distance / pinch.distance),
        Math.min(MIN_SCALE, fitScaleRef.current)
      );
      const ratio = scale / pinch.scale;
      setTransform({
        scale,
        x: midX - (pinch.midX - pinch.x) * ratio,
        y: midY - (pinch.midY - pinch.y) * ratio,
      });
    } else if (panRef.current) {
      const dx = event.clientX - panRef.current.x;
      const dy = event.clientY - panRef.current.y;
      panRef.current = { x: event.clientX, y: event.clientY };
      if (dx === 0 && dy === 0) return;
      setTransform((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
    }
  };

  const handlePointerEnd = (event: PointerEvent) => {
    const pointers = pointersRef.current;
    pointers.delete(event.pointerId);
    if (pointers.size >= 2) {
      rebasePinch(pointers);
    } else {
      pinchRef.current = null;
    }
    if (pointers.size === 1) {
      const [remaining] = Array.from(pointers.values());
      panRef.current = remaining ? { x: remaining.x, y: remaining.y } : null;
    } else if (pointers.size === 0) {
      panRef.current = null;
    }
  };

  return (
    <div
      ref={rootRef}
      class="mermaid-overlay fixed inset-0 z-50 flex animate-fadeIn select-none flex-col bg-scrim-strong backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Mermaid diagram viewer"
    >
      <div class="flex flex-shrink-0 items-center gap-1 border-b border-line bg-surface px-2 py-1.5">
        <button
          type="button"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          class={overlayButtonClass}
        >
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14" />
          </svg>
        </button>
        <span
          class="mermaid-zoom-level w-14 text-center text-sm font-medium text-fg-soft"
          aria-live="polite"
        >
          {Math.round((transform.scale / fitScale) * 100)}%
        </span>
        <button
          type="button"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => zoomBy(ZOOM_STEP)}
          class={overlayButtonClass}
        >
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 5v14M5 12h14"
            />
          </svg>
        </button>
        <button
          type="button"
          title="Fit to screen"
          aria-label="Fit to screen"
          onClick={fitToStage}
          class={overlayButtonClass}
        >
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"
            />
          </svg>
        </button>
        <div class="flex-1" />
        <button
          type="button"
          title="Close"
          aria-label="Close"
          onClick={onClose}
          class={overlayButtonClass}
        >
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
      <div
        ref={stageRef}
        class="mermaid-stage relative flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <div
          ref={contentRef}
          class="mermaid-stage-content absolute top-0 left-0 origin-top-left will-change-transform"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
        />
        {!ready && (
          <div class="absolute inset-0 flex items-center justify-center">
            <div class="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
          </div>
        )}
      </div>
    </div>
  );
}
