import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { Point, ViewportState } from './types';
import { screenToCanvas } from './types';

export interface TransitionLike {
  from: string;
  to: string;
}

export interface ConnectionDragState {
  active: boolean;
  fromStepId: string | null;
  fromPos: Point | null;
  currentPos: Point | null;
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
  viewportState: ViewportState;
  containerRef: RefObject<HTMLElement>;
  transitions: TransitionLike[];
  onCreateTransition: (fromStepId: string, toStepId: string) => void;
}

export interface UseConnectionDragReturn {
  dragState: ConnectionDragState;
  startDrag: (fromStepId: string, portEl: Element, e: MouseEvent) => void;
  setHoverTarget: (stepId: string | null) => void;
}

export function useConnectionDrag({
  viewportState,
  containerRef,
  transitions,
  onCreateTransition,
}: UseConnectionDragOptions): UseConnectionDragReturn {
  const [dragState, setDragState] = useState<ConnectionDragState>(IDLE);

  const viewportRef = useRef(viewportState);
  viewportRef.current = viewportState;

  const transitionsRef = useRef(transitions);
  transitionsRef.current = transitions;

  const onCreateTransitionRef = useRef(onCreateTransition);
  onCreateTransitionRef.current = onCreateTransition;

  const dragRef = useRef<ConnectionDragState>(IDLE);

  const startDrag = useCallback(
    (fromStepId: string, portEl: Element, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const container = containerRef.current;
      const portRect = portEl.getBoundingClientRect();
      const containerRect = container?.getBoundingClientRect() ?? { left: 0, top: 0 };

      const portScreenCenter: Point = {
        x: portRect.left + portRect.width / 2 - containerRect.left,
        y: portRect.top + portRect.height / 2 - containerRect.top,
      };

      const fromPos = screenToCanvas(portScreenCenter, viewportRef.current);

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

  const setHoverTarget = useCallback((stepId: string | null) => {
    if (!dragRef.current.active) return;
    const next = { ...dragRef.current, hoverTargetStepId: stepId };
    dragRef.current = next;
    setDragState(next);
  }, []);

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
        if (fromStepId === hoverTargetStepId) {
          dragRef.current = IDLE;
          setDragState(IDLE);
          return;
        }

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
