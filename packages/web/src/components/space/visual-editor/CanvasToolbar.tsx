import type { NodePosition, ViewportState } from './types';
import { MIN_SCALE, MAX_SCALE } from './VisualCanvas';

export const ZOOM_STEP = 0.25;
export const FIT_PADDING = 40;
const MAX_FIT_SCALE = 1;

export function computeFitToView(
  nodes: NodePosition,
  viewportWidth: number,
  viewportHeight: number,
  padding = FIT_PADDING
): ViewportState {
  const entries = Object.values(nodes);
  if (entries.length === 0) {
    return { offsetX: 0, offsetY: 0, scale: 1 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const { x, y, width, height } of entries) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + width > maxX) maxX = x + width;
    if (y + height > maxY) maxY = y + height;
  }

  const nodesW = maxX - minX;
  const nodesH = maxY - minY;

  const availableW = viewportWidth - 2 * padding;
  const availableH = viewportHeight - 2 * padding;

  const scaleX = availableW > 0 ? availableW / nodesW : 1;
  const scaleY = availableH > 0 ? availableH / nodesH : 1;
  const scale = Math.min(scaleX, scaleY, MAX_FIT_SCALE, MAX_SCALE);
  const clampedScale = Math.max(MIN_SCALE, scale);

  const scaledW = nodesW * clampedScale;
  const scaledH = nodesH * clampedScale;
  const offsetX = (viewportWidth - scaledW) / 2 - minX * clampedScale;
  const offsetY = (viewportHeight - scaledH) / 2 - minY * clampedScale;

  return { offsetX, offsetY, scale: clampedScale };
}

interface CanvasToolbarProps {
  viewport: ViewportState;
  nodes: NodePosition;
  viewportWidth: number;
  viewportHeight: number;
  onViewportChange: (state: ViewportState) => void;
}

export function CanvasToolbar({
  viewport,
  nodes,
  viewportWidth,
  viewportHeight,
  onViewportChange,
}: CanvasToolbarProps) {
  const handleZoomIn = () => {
    const newScale = Math.min(MAX_SCALE, viewport.scale + ZOOM_STEP);
    const cx = viewportWidth / 2;
    const cy = viewportHeight / 2;
    const ratio = newScale / viewport.scale;
    onViewportChange({
      scale: newScale,
      offsetX: cx - (cx - viewport.offsetX) * ratio,
      offsetY: cy - (cy - viewport.offsetY) * ratio,
    });
  };

  const handleZoomOut = () => {
    const newScale = Math.max(MIN_SCALE, viewport.scale - ZOOM_STEP);
    const cx = viewportWidth / 2;
    const cy = viewportHeight / 2;
    const ratio = newScale / viewport.scale;
    onViewportChange({
      scale: newScale,
      offsetX: cx - (cx - viewport.offsetX) * ratio,
      offsetY: cy - (cy - viewport.offsetY) * ratio,
    });
  };

  const handleReset = () => {
    onViewportChange({ offsetX: 0, offsetY: 0, scale: 1 });
  };

  const handleFitToView = () => {
    onViewportChange(computeFitToView(nodes, viewportWidth, viewportHeight));
  };

  const zoomPercent = Math.round(viewport.scale * 100);

  return (
    <div
      class="absolute bottom-4 right-4 flex items-center gap-1 rounded-xl border border-white/10 bg-dark-900/90 px-2 py-1.5 shadow-2xl shadow-black/30 backdrop-blur select-none pointer-events-auto"
      data-testid="canvas-toolbar"
    >
      <button
        type="button"
        class="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-100 hover:bg-white/5 transition-colors text-base font-medium disabled:opacity-40"
        onClick={handleZoomOut}
        title="Zoom out"
        data-testid="canvas-toolbar-zoom-out"
        disabled={viewport.scale <= MIN_SCALE}
      >
        −
      </button>

      <button
        type="button"
        class="min-w-[3rem] h-7 px-1 flex items-center justify-center rounded-lg text-xs text-gray-400 hover:text-gray-100 hover:bg-white/5 transition-colors tabular-nums"
        onClick={handleReset}
        title="Reset zoom (100%)"
        data-testid="canvas-toolbar-reset"
      >
        {zoomPercent}%
      </button>

      <button
        type="button"
        class="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-100 hover:bg-white/5 transition-colors text-base font-medium disabled:opacity-40"
        onClick={handleZoomIn}
        title="Zoom in"
        data-testid="canvas-toolbar-zoom-in"
        disabled={viewport.scale >= MAX_SCALE}
      >
        +
      </button>

      <div class="w-px h-4 bg-white/10 mx-0.5" />

      <button
        type="button"
        class="h-7 px-2 flex items-center justify-center rounded-lg text-xs text-gray-400 hover:text-gray-100 hover:bg-white/5 transition-colors"
        onClick={handleFitToView}
        title="Fit all nodes to view"
        data-testid="canvas-toolbar-fit"
      >
        Fit
      </button>
    </div>
  );
}
