import type { ComponentChildren, Ref, VNode } from 'preact';
import { createContext, createElement, Fragment } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { classNames } from '../../internal/class-names.ts';
import { disposables } from '../../internal/disposables.ts';
import { OpenClosedContext, State, useOpenClosed } from '../../internal/open-closed.ts';
import { render } from '../../internal/render.ts';
import type { ElementType } from '../../internal/types.ts';
import { Features, RenderStrategy } from '../../internal/types.ts';
import { useDisposables } from '../../internal/use-disposables.ts';
import { useEvent } from '../../internal/use-event.ts';
import { useIsoMorphicEffect } from '../../internal/use-iso-morphic-effect.ts';
import { useIsMounted } from '../../internal/use-is-mounted.ts';
import { useLatestValue } from '../../internal/use-latest-value.ts';
import { useServerHandoffComplete } from '../../internal/use-server-handoff-complete.ts';
import { useSyncRefs } from '../../internal/use-sync-refs.ts';
import { useFlags } from '../../internal/use-flags.ts';

if (
  typeof process !== 'undefined' &&
  typeof globalThis !== 'undefined' &&
  typeof Element !== 'undefined' &&
  process?.env?.['NODE' + '_' + 'ENV'] === 'test'
) {
  if (typeof Element?.prototype?.getAnimations === 'undefined') {
    Element.prototype.getAnimations = function getAnimationsPolyfill() {
      return [];
    };
  }
}

type ContainerElement = { current: HTMLElement | null };
type TransitionDirection = 'enter' | 'leave';

enum TransitionState {
  None = 0,
  Closed = 1 << 0,
  Enter = 1 << 1,
  Leave = 1 << 2,
}

type TransitionData = {
  closed?: boolean;
  enter?: boolean;
  leave?: boolean;
  transition?: boolean;
};

function transitionDataAttributes(data: TransitionData): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const key in data) {
    if (data[key as keyof TransitionData] === true) {
      attributes[`data-${key}`] = '';
    }
  }
  return attributes;
}

function shouldForwardRef<TTag extends ElementType = typeof Fragment>(
  props: TransitionRootProps<TTag>
): boolean {
  return (
    Boolean(
      props.enter ||
        props.enterFrom ||
        props.enterTo ||
        props.leave ||
        props.leaveFrom ||
        props.leaveTo
    ) ||
    (props.as ?? Fragment) !== Fragment ||
    false
  );
}

interface TransitionContextValues {
  show: boolean;
  appear: boolean;
  initial: boolean;
}

const TransitionContext = createContext<TransitionContextValues | null>(null);
TransitionContext.displayName = 'TransitionContext';

function useTransitionContext(): TransitionContextValues {
  const context = useContext(TransitionContext);

  if (context === null) {
    throw new Error(
      'A <Transition.Child /> is used but it is missing a parent <Transition /> or <Transition.Root />.'
    );
  }

  return context;
}

enum TreeStates {
  Visible = 'visible',
  Hidden = 'hidden',
}

type ChainEntry = [container: ContainerElement, promise: Promise<void>];

interface NestingContextValues {
  children: { current: { el: ContainerElement; state: TreeStates }[] };
  register: (el: ContainerElement) => () => void;
  unregister: (el: ContainerElement, strategy?: RenderStrategy) => void;
  onStart: (el: ContainerElement, direction: TransitionDirection, cb: () => void) => void;
  onStop: (el: ContainerElement, direction: TransitionDirection, cb: () => void) => void;
  chains: { current: Record<TransitionDirection, ChainEntry[]> };
  wait: { current: Promise<void> };
}

const NestingContext = createContext<NestingContextValues | null>(null);
NestingContext.displayName = 'NestingContext';

function useParentNesting(): NestingContextValues {
  const context = useContext(NestingContext);

  if (context === null) {
    throw new Error(
      'A <Transition.Child /> is used but it is missing a parent <Transition /> or <Transition.Root />.'
    );
  }

  return context;
}

function hasChildren(
  bag: NestingContextValues['children'] | { children: NestingContextValues['children'] }
): boolean {
  if ('children' in bag) return hasChildren(bag.children);
  return (
    bag.current
      .filter(({ el }) => el.current !== null)
      .filter(({ state }) => state === TreeStates.Visible).length > 0
  );
}

function useNesting(done?: () => void, parent?: NestingContextValues): NestingContextValues {
  const doneRef = useLatestValue(done);
  const transitionableChildren = useRef<NestingContextValues['children']['current']>([]);
  const mounted = useIsMounted();
  const d = useDisposables();

  const unregister = useEvent((container: ContainerElement, strategy = RenderStrategy.Hidden) => {
    const idx = transitionableChildren.current.findIndex(({ el }) => el === container);
    if (idx === -1) return;

    if (strategy === RenderStrategy.Unmount) {
      transitionableChildren.current.splice(idx, 1);
    } else {
      transitionableChildren.current[idx].state = TreeStates.Hidden;
    }

    d.microTask(() => {
      if (!hasChildren(transitionableChildren) && mounted.current) {
        doneRef.current?.();
      }
    });
  });

  const register = useEvent((container: ContainerElement) => {
    const child = transitionableChildren.current.find(({ el }) => el === container);
    if (!child) {
      transitionableChildren.current.push({ el: container, state: TreeStates.Visible });
    } else if (child.state !== TreeStates.Visible) {
      child.state = TreeStates.Visible;
    }

    return () => unregister(container, RenderStrategy.Unmount);
  });

  const todos = useRef<(() => void)[]>([]);
  const wait = useRef<Promise<void>>(Promise.resolve());

  const chains = useRef<Record<TransitionDirection, ChainEntry[]>>({ enter: [], leave: [] });

  const onStart = useEvent(
    (
      container: ContainerElement,
      direction: TransitionDirection,
      cb: (direction: TransitionDirection) => void
    ) => {
      todos.current.splice(0);

      if (parent) {
        parent.chains.current[direction] = parent.chains.current[direction].filter(
          ([containerInParent]) => containerInParent !== container
        );
      }

      if (parent) {
        parent.chains.current[direction].push([
          container,
          new Promise<void>((resolve) => {
            todos.current.push(resolve);
          }),
        ]);
      }

      if (parent) {
        parent.chains.current[direction].push([
          container,
          new Promise<void>((resolve) => {
            Promise.all(chains.current[direction].map(([_container, promise]) => promise)).then(
              () => resolve()
            );
          }),
        ]);
      }

      if (direction === 'enter') {
        wait.current = wait.current.then(() => parent?.wait.current).then(() => cb(direction));
      } else {
        cb(direction);
      }
    }
  );

  const onStop = useEvent(
    (
      _container: ContainerElement,
      direction: TransitionDirection,
      cb: (direction: TransitionDirection) => void
    ) => {
      Promise.all(chains.current[direction].splice(0).map(([_container, promise]) => promise))
        .then(() => {
          todos.current.shift()?.();
        })
        .then(() => cb(direction));
    }
  );

  return useMemo(
    () => ({
      children: transitionableChildren,
      register,
      unregister,
      onStart,
      onStop,
      wait,
      chains,
    }),
    [register, unregister, transitionableChildren, onStart, onStop, chains, wait]
  );
}

function useTransition(
  enabled: boolean,
  element: HTMLElement | null,
  show: boolean,
  events?: {
    start?: (show: boolean) => void;
    end?: (show: boolean) => void;
  }
): [visible: boolean, data: TransitionData] {
  const [visible, setVisible] = useState(show);

  const { hasFlag, addFlag, removeFlag } = useFlags(
    enabled && visible ? TransitionState.Enter | TransitionState.Closed : TransitionState.None
  );
  const inFlight = useRef(false);
  const cancelledRef = useRef(false);

  const d = useDisposables();

  useIsoMorphicEffect(() => {
    if (!enabled) return;

    if (show) {
      setVisible(true);
    }

    if (!element) {
      if (show) {
        addFlag(TransitionState.Enter | TransitionState.Closed);
      }
      return;
    }

    events?.start?.(show);

    return transition(element, {
      inFlight,
      prepare() {
        if (cancelledRef.current) {
          cancelledRef.current = false;
        } else {
          cancelledRef.current = inFlight.current;
        }

        inFlight.current = true;

        if (cancelledRef.current) return;

        if (show) {
          addFlag(TransitionState.Enter | TransitionState.Closed);
          removeFlag(TransitionState.Leave);
        } else {
          addFlag(TransitionState.Leave);
          removeFlag(TransitionState.Enter);
        }
      },
      run() {
        if (cancelledRef.current) {
          if (show) {
            removeFlag(TransitionState.Enter | TransitionState.Closed);
            addFlag(TransitionState.Leave);
          } else {
            removeFlag(TransitionState.Leave);
            addFlag(TransitionState.Enter | TransitionState.Closed);
          }
        } else {
          if (show) {
            removeFlag(TransitionState.Closed);
          } else {
            addFlag(TransitionState.Closed);
          }
        }
      },
      done() {
        if (cancelledRef.current) {
          if (hasPendingTransitions(element)) {
            return;
          }
        }

        inFlight.current = false;

        removeFlag(TransitionState.Enter | TransitionState.Leave | TransitionState.Closed);

        if (!show) {
          setVisible(false);
        }

        events?.end?.(show);
      },
    });
  }, [enabled, show, element, d]);

  if (!enabled) {
    return [
      show,
      {
        closed: undefined,
        enter: undefined,
        leave: undefined,
        transition: undefined,
      },
    ] as const;
  }

  return [
    visible,
    {
      closed: hasFlag(TransitionState.Closed),
      enter: hasFlag(TransitionState.Enter),
      leave: hasFlag(TransitionState.Leave),
      transition: hasFlag(TransitionState.Enter) || hasFlag(TransitionState.Leave),
    },
  ] as const;
}

function transition(
  node: HTMLElement,
  {
    prepare,
    run,
    done,
    inFlight,
  }: {
    prepare: () => void;
    run: () => void;
    done: () => void;
    inFlight: { current: boolean };
  }
): () => void {
  const d = disposables();

  prepareTransition(node, {
    prepare,
    inFlight,
  });

  d.nextFrame(() => {
    run();

    d.requestAnimationFrame(() => {
      d.add(waitForTransition(node, done));
    });
  });

  return d.dispose;
}

function waitForTransition(node: HTMLElement | null, done: () => void): () => void {
  const d = disposables();
  if (!node) return d.dispose;

  let cancelled = false;
  d.add(() => {
    cancelled = true;
  });

  const getAnimations = (node as HTMLElement & { getAnimations?: () => Animation[] }).getAnimations;
  const transitions =
    getAnimations?.call(node)?.filter((animation) => animation instanceof CSSTransition) ?? [];

  if (transitions.length === 0) {
    done();
    return d.dispose;
  }

  Promise.allSettled(transitions.map((transition) => transition.finished)).then(() => {
    if (!cancelled) {
      done();
    }
  });

  return d.dispose;
}

function prepareTransition(
  node: HTMLElement,
  { inFlight, prepare }: { inFlight?: { current: boolean }; prepare: () => void }
): void {
  if (inFlight?.current) {
    prepare();
    return;
  }

  const previous = node.style.transition;

  node.style.transition = 'none';

  prepare();

  void node.offsetHeight;

  node.style.transition = previous;
}

function hasPendingTransitions(node: HTMLElement): boolean {
  const getAnimations = (node as HTMLElement & { getAnimations?: () => Animation[] }).getAnimations;
  const animations: Animation[] = getAnimations?.call(node) ?? [];

  return animations.some((animation) => {
    return animation instanceof CSSTransition && animation.playState !== 'finished';
  });
}

export interface TransitionClasses {
  enter?: string;
  enterFrom?: string;
  enterTo?: string;
  entered?: string;
  leave?: string;
  leaveFrom?: string;
  leaveTo?: string;
}

export interface TransitionEvents {
  beforeEnter?: () => void;
  afterEnter?: () => void;
  beforeLeave?: () => void;
  afterLeave?: () => void;
}

export interface TransitionProps<TTag extends ElementType = ElementType>
  extends TransitionClasses,
    TransitionEvents {
  as?: TTag;
  show?: boolean;
  appear?: boolean;
  unmount?: boolean;
  children?: ComponentChildren;
  transition?: boolean;
  ref?: Ref<HTMLElement>;
  [key: string]: unknown;
}

export type TransitionRootProps<TTag extends ElementType = ElementType> = TransitionProps<TTag> & {
  initial?: boolean;
};

export type TransitionChildProps<TTag extends ElementType = ElementType> = TransitionProps<TTag>;

const DEFAULT_TRANSITION_CHILD_TAG = Fragment;
type TransitionChildRenderPropArg = { current: HTMLElement | null };

function TransitionChildFn<TTag extends ElementType = typeof DEFAULT_TRANSITION_CHILD_TAG>(
  props: TransitionChildProps<TTag>,
  ref: Ref<HTMLElement>
): VNode | null {
  const {
    transition = true,
    beforeEnter,
    afterEnter,
    beforeLeave,
    afterLeave,
    enter,
    enterFrom,
    enterTo,
    entered,
    leave,
    leaveFrom,
    leaveTo,
    ...theirProps
  } = props as TransitionChildProps<TTag> & {
    as?: TTag;
    unmount?: boolean;
    className?: string;
  };

  const [localContainerElement, setLocalContainerElement] = useState<HTMLElement | null>(null);
  const container = useRef<HTMLElement | null>(null);
  const requiresRef = shouldForwardRef(props as TransitionRootProps<TTag>);

  const refs = requiresRef ? [container, ref, setLocalContainerElement] : ref === null ? [] : [ref];
  const transitionRef = useSyncRefs(...refs);

  const strategy = (theirProps.unmount ?? true) ? RenderStrategy.Unmount : RenderStrategy.Hidden;

  const { show, appear, initial } = useTransitionContext();

  const [treeState, setState] = useState(show ? TreeStates.Visible : TreeStates.Hidden);

  const parentNesting = useParentNesting();
  const { register, unregister } = parentNesting;

  useIsoMorphicEffect(() => register(container), [register, container]);

  useIsoMorphicEffect(() => {
    if (strategy !== RenderStrategy.Hidden) return;
    if (!container.current) return;

    if (show && treeState !== TreeStates.Visible) {
      setState(TreeStates.Visible);
      return;
    }

    if (treeState === TreeStates.Hidden) {
      return () => unregister(container);
    } else if (treeState === TreeStates.Visible) {
      return () => register(container);
    }
  }, [treeState, container, register, unregister, show, strategy]);

  const ready = useServerHandoffComplete();

  useIsoMorphicEffect(() => {
    if (!requiresRef) return;

    if (ready && treeState === TreeStates.Visible && container.current === null) {
      throw new Error('Did you forget to passthrough the `ref` to the actual DOM node?');
    }
  }, [container, treeState, ready, requiresRef]);

  const skip = initial && !appear;
  const immediate = appear && show && initial;

  const isTransitioning = useRef(false);

  const nesting = useNesting(() => {
    if (isTransitioning.current) return;

    setState(TreeStates.Hidden);
    unregister(container);
  }, parentNesting);

  const start = useEvent((show: boolean) => {
    isTransitioning.current = true;
    const direction: TransitionDirection = show ? 'enter' : 'leave';

    nesting.onStart(container, direction, () => {
      if (direction === 'enter') beforeEnter?.();
      else if (direction === 'leave') beforeLeave?.();
    });
  });

  const end = useEvent((show: boolean) => {
    const direction: TransitionDirection = show ? 'enter' : 'leave';

    isTransitioning.current = false;
    nesting.onStop(container, direction, () => {
      if (direction === 'enter') afterEnter?.();
      else if (direction === 'leave') afterLeave?.();
    });

    if (direction === 'leave' && !hasChildren(nesting)) {
      setState(TreeStates.Hidden);
      unregister(container);
    }
  });

  useEffect(() => {
    if (requiresRef && transition) return;

    start(show);
    end(show);
  }, [show, requiresRef, transition]);

  const enabled = (() => {
    if (!transition) return false;
    if (!requiresRef) return false;
    if (!ready) return false;
    if (skip) return false;

    return true;
  })();

  const [, transitionData] = useTransition(enabled, localContainerElement, show, { start, end });

  const ourProps: Record<string, unknown> = {
    ref: transitionRef,
    className:
      classNames(
        (theirProps as { className?: string }).className,
        immediate && enter,
        immediate && enterFrom,
        transitionData.enter && enter,
        transitionData.enter && transitionData.closed && enterFrom,
        transitionData.enter && !transitionData.closed && enterTo,
        transitionData.leave && leave,
        transitionData.leave && !transitionData.closed && leaveFrom,
        transitionData.leave && transitionData.closed && leaveTo,
        !transitionData.transition && show && entered
      ) || undefined,
    ...transitionDataAttributes(transitionData),
  };

  if (treeState === TreeStates.Visible) {
    ourProps['data-headlessui-state'] = 'open';
    ourProps['data-open'] = '';
  }

  let openClosedState = 0;
  if (treeState === TreeStates.Visible) openClosedState |= State.Open;
  if (treeState === TreeStates.Hidden) openClosedState |= State.Closed;

  return createElement(
    NestingContext.Provider,
    { value: nesting },
    createElement(
      OpenClosedContext.Provider,
      { value: openClosedState },
      render({
        ourProps,
        theirProps: { ...theirProps, as: theirProps.as ?? DEFAULT_TRANSITION_CHILD_TAG },
        slot: {} as TransitionChildRenderPropArg,
        defaultTag: DEFAULT_TRANSITION_CHILD_TAG,
        features: Features.RenderStrategy,
        visible: treeState === TreeStates.Visible,
        name: 'Transition.Child',
      })
    )
  ) as VNode;
}

TransitionChildFn.displayName = 'Transition.Child';

function TransitionRootFn<TTag extends ElementType = typeof DEFAULT_TRANSITION_CHILD_TAG>(
  props: TransitionRootProps<TTag>,
  ref: Ref<HTMLElement>
): VNode | null {
  const {
    show,
    appear = false,
    unmount = true,
    initial = true,
    ...theirProps
  } = props as TransitionRootProps<TTag>;

  const internalTransitionRef = useRef<HTMLElement | null>(null);
  const requiresRef = shouldForwardRef(props);

  const refs = requiresRef ? [internalTransitionRef, ref] : ref === null ? [] : [ref];
  const transitionRef = useSyncRefs(...refs);

  useServerHandoffComplete();

  let usesOpenClosedState = useOpenClosed();
  let resolvedShow = show;

  if (resolvedShow === undefined && usesOpenClosedState !== null) {
    resolvedShow = (usesOpenClosedState & State.Open) === State.Open;
  }

  if (resolvedShow === undefined) {
    throw new Error('A <Transition /> is used but it is missing a `show={true | false}` prop.');
  }

  const [state, setState] = useState(resolvedShow ? TreeStates.Visible : TreeStates.Hidden);

  const nestingBag = useNesting(() => {
    if (resolvedShow) return;
    setState(TreeStates.Hidden);
  });

  const [initialState, setInitial] = useState(initial);

  const changes = useRef([resolvedShow]);
  useIsoMorphicEffect(() => {
    if (initialState === false) {
      return;
    }

    if (changes.current[changes.current.length - 1] !== resolvedShow) {
      changes.current.push(resolvedShow);
      setInitial(false);
    }
  }, [changes, resolvedShow]);

  const transitionBag = useMemo<TransitionContextValues>(
    () => ({ show: resolvedShow, appear, initial: initialState }),
    [resolvedShow, appear, initialState]
  );

  useIsoMorphicEffect(() => {
    if (resolvedShow) {
      setState(TreeStates.Visible);
    } else if (!hasChildren(nestingBag) && internalTransitionRef.current !== null) {
      setState(TreeStates.Hidden);
    }
  }, [resolvedShow, nestingBag]);

  const sharedProps = { unmount };

  const beforeEnter = useEvent(() => {
    if (initialState) setInitial(false);
    (props as TransitionRootProps<TTag>).beforeEnter?.();
  });

  const beforeLeave = useEvent(() => {
    if (initialState) setInitial(false);
    (props as TransitionRootProps<TTag>).beforeLeave?.();
  });

  return createElement(
    NestingContext.Provider,
    { value: nestingBag },
    createElement(
      TransitionContext.Provider,
      { value: transitionBag },
      render({
        ourProps: {
          ...sharedProps,
          as: Fragment,
          children: createElement(InternalTransitionChild, {
            ref: transitionRef,
            ...sharedProps,
            ...theirProps,
            beforeEnter,
            beforeLeave,
          }),
        },
        theirProps: {},
        slot: {},
        defaultTag: Fragment,
        features: Features.RenderStrategy,
        visible: state === TreeStates.Visible,
        name: 'Transition',
      })
    )
  ) as VNode;
}

TransitionRootFn.displayName = 'Transition';

function ChildFn<TTag extends ElementType = typeof DEFAULT_TRANSITION_CHILD_TAG>(
  props: TransitionChildProps<TTag>,
  ref: Ref<HTMLElement>
): VNode | null {
  const hasTransitionContext = useContext(TransitionContext) !== null;
  const hasOpenClosedContext = useOpenClosed() !== null;

  if (!hasTransitionContext && hasOpenClosedContext) {
    return createElement(TransitionRoot, { ...props, ref } as Record<string, unknown>);
  }

  return createElement(InternalTransitionChild, { ...props, ref } as Record<string, unknown>);
}

ChildFn.displayName = 'TransitionChild';

function InternalTransitionChild(
  props: TransitionChildProps<ElementType> & { ref?: Ref<HTMLElement> }
): VNode | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (TransitionChildFn as any)(props, props.ref);
}

export function TransitionChild<TTag extends ElementType = typeof DEFAULT_TRANSITION_CHILD_TAG>(
  props: TransitionChildProps<TTag> & { ref?: Ref<HTMLElement> }
): VNode | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (ChildFn as any)(props, props.ref);
}

export function TransitionRoot<TTag extends ElementType = typeof DEFAULT_TRANSITION_CHILD_TAG>(
  props: TransitionRootProps<TTag> & { ref?: Ref<HTMLElement> }
): VNode | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (TransitionRootFn as any)(props, props.ref);
}

export const Transition = Object.assign(TransitionRoot, {
  Child: TransitionChild,
  Root: TransitionRoot,
});
