import { ComponentChildren } from 'preact';
import { useMemo, useEffect } from 'preact/hooks';
import { createPortal } from 'preact/compat';

interface PortalProps {
  children: ComponentChildren;
  into?: string | HTMLElement;
}

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
