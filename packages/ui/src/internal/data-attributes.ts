import type { RefObject } from 'preact';
import { useEffect, useState } from 'preact/hooks';

interface InteractionState {
  hover: boolean;
  focus: boolean;
  active: boolean;
}

export function useInteractionState(
  ref: RefObject<HTMLElement | null>,
  options: { disabled?: boolean } = {}
): InteractionState {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(false);
  const { disabled = false } = options;

  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) {
      setHover(false);
      setFocus(false);
      setActive(false);
      return;
    }

    const onPointerEnter = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      setHover(true);
    };
    const onPointerLeave = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      setHover(false);
      setActive(false);
    };

    let hadKeyboardEvent = false;
    const onKeyDown = () => {
      hadKeyboardEvent = true;
    };
    const onFocus = () => {
      if (hadKeyboardEvent) {
        setFocus(true);
      }
    };
    const onBlur = () => {
      setFocus(false);
      hadKeyboardEvent = false;
    };

    const onPointerDown = () => setActive(true);
    const onPointerUp = () => setActive(false);

    el.addEventListener('pointerenter', onPointerEnter);
    el.addEventListener('pointerleave', onPointerLeave);
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerup', onPointerUp);
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      el.removeEventListener('pointerenter', onPointerEnter);
      el.removeEventListener('pointerleave', onPointerLeave);
      el.removeEventListener('focus', onFocus);
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [ref, disabled]);

  return { hover, focus, active };
}

export function dataAttributes(slot: Record<string, unknown>): Record<string, string | undefined> {
  const attrs: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(slot)) {
    if (typeof value === 'boolean') {
      attrs[`data-${key}`] = value ? '' : undefined;
    }
  }
  return attrs;
}
