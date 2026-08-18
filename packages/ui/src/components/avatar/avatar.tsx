import { createContext, createElement } from 'preact';
import { useCallback, useContext, useEffect, useState } from 'preact/hooks';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
type AvatarShape = 'circle' | 'rounded';
type AvatarStatus = 'online' | 'busy' | 'away' | 'offline';

interface AvatarContextValue {
  size: AvatarSize;
  shape: AvatarShape;
  status?: AvatarStatus;
}

const AvatarContext = createContext<AvatarContextValue | null>(null);
AvatarContext.displayName = 'AvatarContext';

function useAvatarContext(component: string): AvatarContextValue {
  const ctx = useContext(AvatarContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used within an <Avatar>`);
  }
  return ctx;
}

interface AvatarGroupContextValue {
  size: AvatarSize;
  max: number;
  visible: number;
  overflow: number;
  count: number;
}

const AvatarGroupContext = createContext<AvatarGroupContextValue | null>(null);
AvatarGroupContext.displayName = 'AvatarGroupContext';

function useAvatarGroupContext(component: string): AvatarGroupContextValue {
  const ctx = useContext(AvatarGroupContext);
  if (ctx === null) {
    throw new Error(`<${component}> must be used within an <AvatarGroup>`);
  }
  return ctx;
}

interface AvatarProps {
  src?: string;
  alt?: string;
  size?: AvatarSize;
  shape?: AvatarShape;
  status?: AvatarStatus;
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function AvatarFn({
  size = 'md',
  shape = 'circle',
  status,
  as: Tag = 'span',
  children,
  ...rest
}: AvatarProps) {
  const ctx: AvatarContextValue = { size, shape, status };

  const slot = {};

  const ourProps: Record<string, unknown> = {
    'data-size': size,
    'data-shape': shape,
    'data-status': status,
  };

  const inner = render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'span',
    name: 'Avatar',
  });

  return createElement(AvatarContext.Provider, { value: ctx }, inner);
}

AvatarFn.displayName = 'Avatar';
export const Avatar = AvatarFn;

interface AvatarGroupProps {
  max?: number;
  size?: AvatarSize;
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function AvatarGroupFn({ max, size = 'md', as: Tag = 'div', children, ...rest }: AvatarGroupProps) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let visible = 0;
    const traverse = (node: preact.ComponentChildren) => {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach(traverse);
        return;
      }
      const vnode = node as preact.VNode;
      if (
        vnode.type === Avatar ||
        (typeof vnode.type === 'function' && vnode.type.displayName === 'Avatar')
      ) {
        visible++;
      } else if (
        vnode.type === AvatarGroupOverflow ||
        (typeof vnode.type === 'function' && vnode.type.displayName === 'AvatarGroupOverflow')
      ) {
        // Don't count overflow
      } else if (vnode.props?.children) {
        traverse(vnode.props.children);
      }
    };
    traverse(children as preact.ComponentChildren);
    setCount(visible);
  }, [children]);

  const overflow = max !== undefined ? Math.max(0, count - max) : 0;
  const visible = max !== undefined ? Math.min(count, max) : count;

  const ctx: AvatarGroupContextValue = { size, max: max ?? count, visible, overflow, count };

  const slot = { overflow: overflow > 0, count: overflow };

  const ourProps: Record<string, unknown> = {
    'data-overflow': overflow > 0 || undefined,
  };

  const inner = render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'div',
    name: 'AvatarGroup',
  });

  return createElement(AvatarGroupContext.Provider, { value: ctx }, inner);
}

AvatarGroupFn.displayName = 'AvatarGroup';
export const AvatarGroup = AvatarGroupFn;

interface AvatarGroupOverflowProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function AvatarGroupOverflowFn({ as: Tag = 'span', children, ...rest }: AvatarGroupOverflowProps) {
  const { overflow, count } = useAvatarGroupContext('AvatarGroupOverflow');

  const ourProps: Record<string, unknown> = {
    'data-count': count || undefined,
  };

  const slot = { overflow, count };

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'span',
    name: 'AvatarGroupOverflow',
  });
}

AvatarGroupOverflowFn.displayName = 'AvatarGroupOverflow';
export const AvatarGroupOverflow = AvatarGroupOverflowFn;

interface AvatarImageProps {
  src?: string;
  alt?: string;
  onLoad?: () => void;
  onError?: () => void;
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function AvatarImageFn({ src, alt, onLoad, onError, as: Tag = 'img', ...rest }: AvatarImageProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const handleLoad = useCallback(() => {
    setLoaded(true);
    onLoad?.();
  }, [onLoad]);

  const handleError = useCallback(() => {
    setError(true);
    onError?.();
  }, [onError]);

  useAvatarContext('AvatarImage');

  const ourProps: Record<string, unknown> = {
    src,
    alt: alt ?? '',
    onLoad: handleLoad,
    onError: handleError,
    'data-loaded': loaded || undefined,
    'data-error': error || undefined,
  };

  const slot = { loaded, error };

  return render({
    ourProps,
    theirProps: { as: Tag, children: undefined, ...rest },
    slot,
    defaultTag: 'img',
    name: 'AvatarImage',
  });
}

AvatarImageFn.displayName = 'AvatarImage';
export const AvatarImage = AvatarImageFn;

interface AvatarFallbackProps {
  as?: ElementType;
  children?: unknown;
  [key: string]: unknown;
}

function AvatarFallbackFn({ as: Tag = 'span', children, ...rest }: AvatarFallbackProps) {
  useAvatarContext('AvatarFallback');

  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 0);
    return () => clearTimeout(timer);
  }, []);

  const slot = { visible };

  const ourProps: Record<string, unknown> = {};

  return render({
    ourProps,
    theirProps: { as: Tag, children, ...rest },
    slot,
    defaultTag: 'span',
    name: 'AvatarFallback',
  });
}

AvatarFallbackFn.displayName = 'AvatarFallback';
export const AvatarFallback = AvatarFallbackFn;

interface AvatarStatusProps {
  status: AvatarStatus;
  as?: ElementType;
  [key: string]: unknown;
}

function AvatarStatusFn({ status, as: Tag = 'span', ...rest }: AvatarStatusProps) {
  useAvatarContext('AvatarStatus');

  const slot = {};

  const ourProps: Record<string, unknown> = {
    'aria-label': `Status: ${status}`,
  };

  return render({
    ourProps,
    theirProps: { as: Tag, ...rest },
    slot,
    defaultTag: 'span',
    name: 'AvatarStatus',
  });
}

AvatarStatusFn.displayName = 'AvatarStatus';
export const AvatarStatus = AvatarStatusFn;
