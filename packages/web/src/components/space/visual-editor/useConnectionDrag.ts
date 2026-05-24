/**
 * useConnectionDrag
 *
 * Hook that manages port-drag interactions used to create transitions.
 *
 * Usage:
 *  1. Call `startDrag(fromStepId, portScreenCenter, e)` from a node port mousedown.
 *  2. Call `setHoverTarget(stepId | null)` from input port mouseenter/mouseleave.
 *  3. The hook tracks the ghost-edge endpoint via window mousemove.
 *  4. On window mouseup it either commits or cancels the connection.
 *
 * The hook converts screen coordinates → canvas coordinates using the current viewport so
 * the ghost edge can be drawn in SVG canvas-space without extra transforms.
 */

import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { Point, ViewportState } from './types';
import { screenToCanvas } from './types';

// ============================================================================
// Types
// ============================================================================

export interface TransitionLike {
  from: string;
  to: string;
}

export interface ConnectionDragState {
  /** Whether a connection drag is currently in progress */
  active: boolean;
  /** Step ID of the source node */
  fromStepId: string | null;
  /** Canvas-space center of the source output port */
  fromPos: Point | null;
  /** Canvas-space position of the current mouse cursor */
  currentPos: Point | null;
  /** Step ID of the input port currently being hovered, or null */
  hoverTargetStepId: string | null;
}

const IDLE: ConnectionDragState = {
  active: false,
  fromStepId: null,
  fromPos: null,
  currentPos: null,
  hoverTargetStepId: null,
};

export interface UseConnectionDragOptions {
  /** Used to convert screen coordinates to canvas coordinates */
  viewportState: ViewportState;
  /** Container element used to compute relative coordinates */
  containerRef: RefObject<HTMLElement>;
  /** Existing transitions — used to block duplicate edges */
  transitions: TransitionLike[];
  /** Called when the user successfully drops onto a valid input port */
  onCreateTransition: (fromStepId: string, toStepId: string) => void;
}

export interface UseConnectionDragReturn {
  /** Current drag state — read by the canvas to render the ghost edge and highlights */
  dragState: ConnectionDragState;
  /**
   * Call this from a node port onMouseDown handler.
   * @param fromStepId  The step the connection originates from
   * @param portEl      The port DOM element (used to compute screen-space center)
   * @param e           The originating mouse event (used for initial cursor position)
   */
  startDrag: (fromStepId: string, portEl: Element, e: MouseEvent) => void;
  /**
   * Call this from a node's **input** port onMouseEnter/onMouseLeave handler.
   * Pass null on mouseleave.
   */
  setHoverTarget: (stepId: string | null) => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useConnectionDrag({
  viewportState,
  containerRef,
  transitions,
  onCreateTransition,
}: UseConnectionDragOptions): UseConnectionDragReturn {
  const [dragState, setDragState] = useState<ConnectionDragState>(IDLE);

  // Keep refs to avoid stale closures inside window listeners
  const viewportRef = useRef(viewportState);
  viewportRef.current = viewportState;

  const transitionsRef = useRef(transitions);
  transitionsRef.current = transitions;

  const onCreateTransitionRef = useRef(onCreateTransition);
  onCreateTransitionRef.current = onCreateTransition;

  // Mutable ref holding drag state for use inside window listeners
  // (setState is async; we need synchronous access to fromStepId and hoverTarget)
  const dragRef = useRef<ConnectionDragState>(IDLE);

  // ---- startDrag ----
  const startDrag = useCallback(
    (fromStepId: string, portEl: Element, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const container = containerRef.current;
      const portRect = portEl.getBoundingClientRect();
      const containerRect = container?.getBoundingClientRect() ?? { left: 0, top: 0 };

      // Port center in screen coordinates (relative to container)
      const portScreenCenter: Point = {
        x: portRect.left + portRect.width / 2 - containerRect.left,
        y: portRect.top + portRect.height / 2 - containerRect.top,
      };

      const fromPos = screenToCanvas(portScreenCenter, viewportRef.current);

      // Cursor position at start of drag
      const cursorScreen: Point = {
        x: e.clientX - containerRect.left,
        y: e.clientY - containerRect.top,
      };
      const currentPos = screenToCanvas(cursorScreen, viewportRef.current);

      const next: ConnectionDragState = {
        active: true,
        fromStepId,
        fromPos,
        currentPos,
        hoverTargetStepId: null,
      };

      dragRef.current = next;
      setDragState(next);
    },
    [containerRef]
  );

  // ---- setHoverTarget ----
  const setHoverTarget = useCallback((stepId: string | null) => {
    if (!dragRef.current.active) return;
    const next = { ...dragRef.current, hoverTargetStepId: stepId };
    dragRef.current = next;
    setDragState(next);
  }, []);

  // ---- Window listeners (registered once; guard on dragRef.current.active) ----
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current.active) return;

      const containerRect = containerRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const cursorScreen: Point = {
        x: e.clientX - containerRect.left,
        y: e.clientY - containerRect.top,
      };
      const currentPos = screenToCanvas(cursorScreen, viewportRef.current);

      const next = { ...dragRef.current, currentPos };
      dragRef.current = next;
      setDragState(next);
    };

    const onMouseUp = () => {
      if (!dragRef.current.active) return;

      const { fromStepId, hoverTargetStepId } = dragRef.current;

      if (fromStepId && hoverTargetStepId) {
        // Validate: no self-connections
        if (fromStepId === hoverTargetStepId) {
          dragRef.current = IDLE;
          setDragState(IDLE);
          return;
        }

        // Validate: no duplicate transitions
        const isDuplicate = transitionsRef.current.some(
          (t) => t.from === fromStepId && t.to === hoverTargetStepId
        );
        if (!isDuplicate) {
          onCreateTransitionRef.current(fromStepId, hoverTargetStepId);
        }
      }

      dragRef.current = IDLE;
      setDragState(IDLE);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current.active) {
        dragRef.current = IDLE;
        setDragState(IDLE);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [containerRef]);

  return { dragState, startDrag, setHoverTarget };
}
