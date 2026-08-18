import type { ComponentChildren, VNode } from 'preact';
import { createElement } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';

interface PortalProps {
  children: ComponentChildren;
  enabled?: boolean;
}

const PORTAL_ROOT_ID = 'headlessui-portal-root';

function getPortalRoot(): HTMLElement {
  let root = document.getElementById(PORTAL_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = PORTAL_ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
}

export function Portal({ children, enabled = true }: PortalProps): VNode | null {
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const portalRoot = getPortalRoot();
    const container = document.createElement('div');
    portalRoot.appendChild(container);
    containerRef.current = container;
    setMounted(true);

    return () => {
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      }
      containerRef.current = null;

      const root = document.getElementById(PORTAL_ROOT_ID);
      if (root && root.children.length === 0) {
        root.remove();
      }
    };
  }, [enabled]);

  if (!enabled) {
    return createElement('span', null, children);
  }

  if (!mounted || !containerRef.current) return null;

  return createPortal(children, containerRef.current) as VNode;
}

Portal.displayName = 'Portal';
