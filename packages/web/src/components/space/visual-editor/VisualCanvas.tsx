import { useEffect, useRef, useCallback, useState, useMemo } from 'preact/hooks';
import type { ComponentChildren, RefObject } from 'preact';
import type { NodePosition, ViewportState } from './types';
import { CanvasToolbar } from './CanvasToolbar';

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2.0;

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function getTouchDistance(touches: TouchList): number {
  const first = touches[0];
  const second = touches[1];
  const dx = second.clientX - first.clientX;
  const dy = second.clientY - first.clientY;
  return Math.hypot(dx, dy);
}

function getTouchMidpoint(touches: TouchList, rect: DOMRect): { x: number; y: number } {
  const first = touches[0];
  const second = touches[1];
  const clientX = (first.clientX + second.clientX) / 2;
  const clientY = (first.clientY + second.clientY) / 2;
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

export function applyWheelEvent(
  vp: ViewportState,
  deltaX: number,
  deltaY: number,
  isZoom: boolean,
  cursorX = 0,
  cursorY = 0
): ViewportState {
  if (isZoom) {
    const zoomFactor = 1 - deltaY * 0.005;
    const newScale = clampScale(vp.scale * zoomFactor);
    const newOffsetX = cursorX - (cursorX - vp.offsetX) * (newScale / vp.scale);
    const newOffsetY = cursorY - (cursorY - vp.offsetY) * (newScale / vp.scale);
    return { offsetX: newOffsetX, offsetY: newOffsetY, scale: newScale };
  }
  return { ...vp, offsetX: vp.offsetX - deltaX, offsetY: vp.offsetY - deltaY };
}

interface VisualCanvasProps {
  children?: ComponentChildren;
  viewportState: ViewportState;
  onViewportChange: (state: ViewportState) => void;
  onBackgroundClick?: () => void;
  edgeLayer?: (viewport: ViewportState) => ComponentChildren;
  nodes?: NodePosition;
  showToolbar?: boolean;
  containerRef?: RefObject<HTMLDivElement>;
}

export function VisualCanvas({
  children,
  viewportState,
  onViewportChange,
  onBackgroundClick,
  edgeLayer,
  nodes = {},
  showToolbar = true,
  containerRef: externalContainerRef,
}: VisualCanvasProps) {
  const internalContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = externalContainerRef ?? internalContainerRef;
  const transformRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });

  const contentBounds = useMemo(() => {
    const entries = Object.values(nodes);
    if (entries.length === 0) {
      return {
        width: containerSize.width,
        height: containerSize.height,
      };
    }

    let maxX = 0;
    let maxY = 0;
    for (const node of entries) {
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }

    const CONTENT_PADDING = 120;
    return {
      width: Math.max(containerSize.width, maxX + CONTENT_PADDING),
      height: Math.max(containerSize.height, maxY + CONTENT_PADDING),
    };
  }, [nodes, containerSize.height, containerSize.width]);

  const spacebarDown = useRef(false);
  const dragState = useRef<{
    startX: number;
    startY: number;
    originOffsetX: number;
    originOffsetY: number;
  } | null>(null);
  const didDrag = useRef(false);

  const touchPanState = useRef<{
    touchId: number;
    startX: number;
    startY: number;
    originOffsetX: number;
    originOffsetY: number;
  } | null>(null);

  const pinchState = useRef<{
    initialDistance: number;
    initialScale: number;
    initialCanvasX: number;
    initialCanvasY: number;
  } | null>(null);

  const viewportRef = useRef(viewportState);
  viewportRef.current = viewportState;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    obs.observe(el);
    setContainerSize({ width: el.clientWidth, height: el.clientHeight });
    return () => obs.disconnect();
  }, []);

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const vp = viewportRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      const cursorX = e.clientX - (rect?.left ?? 0);
      const cursorY = e.clientY - (rect?.top ?? 0);
      onViewportChange(applyWheelEvent(vp, e.deltaX, e.deltaY, e.ctrlKey, cursorX, cursorY));
    },
    [onViewportChange]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        spacebarDown.current = true;
        if (containerRef.current) {
          containerRef.current.style.cursor = 'grab';
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spacebarDown.current = false;
        dragState.current = null;
        if (containerRef.current) {
          containerRef.current.style.cursor = '';
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (e.button !== 0) return;

    const target = e.target as HTMLElement | null;
    const isBackgroundSurface = target === containerRef.current || target === transformRef.current;
    const isPanSurface = !!target?.closest('[data-pan-canvas="true"]');
    const shouldPan = spacebarDown.current || isBackgroundSurface || isPanSurface;
    if (!shouldPan) return;

    e.preventDefault();
    didDrag.current = false;
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      originOffsetX: viewportRef.current.offsetX,
      originOffsetY: viewportRef.current.offsetY,
    };
    if (containerRef.current) {
      containerRef.current.style.cursor = 'grabbing';
    }
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragState.current) return;
      didDrag.current = true;
      const dx = e.clientX - dragState.current.startX;
      const dy = e.clientY - dragState.current.startY;
      onViewportChange({
        ...viewportRef.current,
        offsetX: dragState.current.originOffsetX + dx,
        offsetY: dragState.current.originOffsetY + dy,
      });
    },
    [onViewportChange]
  );

  const handleMouseUp = useCallback(() => {
    if (!dragState.current) return;
    dragState.current = null;
    if (containerRef.current) {
      containerRef.current.style.cursor = spacebarDown.current ? 'grab' : '';
    }
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (e.touches.length >= 2) {
      touchPanState.current = null;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const distance = getTouchDistance(e.touches);
      if (distance <= 0) return;
      const midpoint = getTouchMidpoint(e.touches, rect);
      const vp = viewportRef.current;
      pinchState.current = {
        initialDistance: distance,
        initialScale: vp.scale,
        initialCanvasX: (midpoint.x - vp.offsetX) / vp.scale,
        initialCanvasY: (midpoint.y - vp.offsetY) / vp.scale,
      };
      e.preventDefault();
      return;
    }

    pinchState.current = null;
    if (e.touches.length !== 1) return;
    const target = e.target as HTMLElement | null;
    const isBackgroundSurface = target === containerRef.current || target === transformRef.current;
    const isPanSurface = !!target?.closest('[data-pan-canvas="true"]');
    if (!isBackgroundSurface && !isPanSurface) return;
    const touch = e.touches[0];
    touchPanState.current = {
      touchId: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      originOffsetX: viewportRef.current.offsetX,
      originOffsetY: viewportRef.current.offsetY,
    };
    didDrag.current = false;
    e.preventDefault();
  }, []);

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      const pinch = pinchState.current;
      if (pinch && e.touches.length >= 2) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const distance = getTouchDistance(e.touches);
        if (distance <= 0) return;
        const midpoint = getTouchMidpoint(e.touches, rect);
        const nextScale = clampScale(pinch.initialScale * (distance / pinch.initialDistance));
        onViewportChange({
          offsetX: midpoint.x - pinch.initialCanvasX * nextScale,
          offsetY: midpoint.y - pinch.initialCanvasY * nextScale,
          scale: nextScale,
        });
        e.preventDefault();
        return;
      }

      const pan = touchPanState.current;
      if (!pan || e.touches.length !== 1) return;
      const touch = Array.from(e.touches).find((t) => t.identifier === pan.touchId) ?? e.touches[0];
      const dx = touch.clientX - pan.startX;
      const dy = touch.clientY - pan.startY;
      didDrag.current = true;
      onViewportChange({
        ...viewportRef.current,
        offsetX: pan.originOffsetX + dx,
        offsetY: pan.originOffsetY + dy,
      });
      e.preventDefault();
    },
    [onViewportChange]
  );

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    if (e.touches.length < 2) {
      pinchState.current = null;
    }
    if (e.touches.length === 0) {
      touchPanState.current = null;
    }
  }, []);

  const handleContainerClick = useCallback(
    (e: MouseEvent) => {
      if (didDrag.current) {
        didDrag.current = false;
        return;
      }
      const target = e.target as HTMLElement;
      const isBackground = target === containerRef.current || target === transformRef.current;
      if (isBackground) {
        onBackgroundClick?.();
      }
    },
    [onBackgroundClick]
  );

  const transform = `translate(${viewportState.offsetX}px, ${viewportState.offsetY}px) scale(${viewportState.scale})`;

  return (
    <div
      ref={containerRef}
      class="visual-canvas-container"
      style={{
        overflow: 'hidden',
        width: '100%',
        height: '100%',
        position: 'relative',
        touchAction: 'none',
      }}
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onClick={handleContainerClick}
      data-testid="visual-canvas"
    >
      <div
        ref={transformRef}
        class="visual-canvas-transform"
        style={{
          transform,
          transformOrigin: '0 0',
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${contentBounds.width}px`,
          height: `${contentBounds.height}px`,
        }}
        data-testid="visual-canvas-transform"
      >
        <svg
          class="visual-canvas-edge-layer"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            overflow: 'visible',
          }}
          data-testid="visual-canvas-svg"
        >
          {edgeLayer?.(viewportState)}
        </svg>
        {children}
      </div>
      {showToolbar && (
        <CanvasToolbar
          viewport={viewportState}
          nodes={nodes}
          viewportWidth={containerSize.width}
          viewportHeight={containerSize.height}
          onViewportChange={onViewportChange}
        />
      )}
    </div>
  );
}
