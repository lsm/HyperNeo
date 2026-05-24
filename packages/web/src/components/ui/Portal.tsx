import { ComponentChildren } from 'preact';
import { useMemo, useEffect } from 'preact/hooks';
import { createPortal } from 'preact/compat';

interface PortalProps {
  children: ComponentChildren;
  into?: string | HTMLElement;
}

/**
 * Portal component for Preact 10+
 *
 * Renders children into a DOM node outside the parent component's DOM hierarchy
 * using Preact's built-in createPortal. Because createPortal keeps children inside
 * the main Preact VNode tree, cleanup is guaranteed when the parent unmounts —
 * no stale portal overlays can persist after navigation.
 *
 * @example
 * <Portal into="body">
 *   <div>Rendered into document.body</div>
 * </Portal>
 */
export function Portal({ children, into = 'body' }: PortalProps) {
  const container = useMemo(() => {
    const el = document.createElement('div');
    el.setAttribute('data-portal', 'true');
    return el;
  }, []);

  useEffect(() => {
    const target = typeof into === 'string' ? document.querySelector(into) : into;
    if (target) {
      target.appendChild(container);
    }
    return () => {
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      }
    };
  }, [into, container]);

  return createPortal(children, container);
}
