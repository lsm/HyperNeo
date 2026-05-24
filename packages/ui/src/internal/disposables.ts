import { microTask } from './micro-task.ts';

/**
 * Interface for the disposables API.
 */
interface DisposablesApi {
  addEventListener: <TEventName extends keyof WindowEventMap>(
    element: HTMLElement | Window | Document,
    name: TEventName,
    listener: (event: WindowEventMap[TEventName]) => unknown,
    options?: boolean | AddEventListenerOptions
  ) => () => void;
  requestAnimationFrame: (...args: Parameters<typeof requestAnimationFrame>) => () => void;
  nextFrame: (...args: Parameters<typeof requestAnimationFrame>) => () => void;
  setTimeout: (...args: Parameters<typeof setTimeout>) => () => void;
  microTask: (...args: Parameters<typeof microTask>) => () => void;
  style: (node: ElementCSSInlineStyle, property: string, value: string) => () => void;
  group: (cb: (d: DisposablesApi) => void) => () => void;
  add: (cb: () => void) => () => void;
  dispose: () => void;
}

export type Disposables = DisposablesApi;

/**
 * Disposables are a way to manage event handlers and functions like
 * `setTimeout` and `requestAnimationFrame` that need to be cleaned up when they
 * are no longer needed.
 *
 * When you register a disposable function, it is added to a collection of
 * disposables. Each disposable in the collection provides a cleanup function
 * that can be called when it's no longer needed. There is also a `dispose`
 * function on the collection itself that can be used to clean up all pending
 * disposables in that collection.
 *
 * @example
 * ```ts
 * const d = disposables();
 * d.addEventListener(element, 'click', handleClick);
 * d.setTimeout(() => {}, 1000);
 * d.requestAnimationFrame(() => {});
 * // Later, clean up all at once:
 * d.dispose();
 * ```
 */
export function disposables(): DisposablesApi {
  const _disposables: (() => void)[] = [];

  const api: DisposablesApi = {
    /**
     * Add an event listener that will be automatically removed on dispose.
     */
    addEventListener<TEventName extends keyof WindowEventMap>(
      element: HTMLElement | Window | Document,
      name: TEventName,
      listener: (event: WindowEventMap[TEventName]) => unknown,
      options?: boolean | AddEventListenerOptions
    ): () => void {
      element.addEventListener(name, listener as EventListener, options);
      return api.add(() => element.removeEventListener(name, listener as EventListener, options));
    },

    /**
     * Schedule a requestAnimationFrame that will be automatically cancelled on dispose.
     */
    requestAnimationFrame(...args: Parameters<typeof requestAnimationFrame>): () => void {
      const raf = requestAnimationFrame(...args);
      return api.add(() => cancelAnimationFrame(raf));
    },

    /**
     * Schedule a callback on the next frame (double rAF).
     */
    nextFrame(...args: Parameters<typeof requestAnimationFrame>): () => void {
      return api.requestAnimationFrame(() => {
        return api.requestAnimationFrame(...args);
      });
    },

    /**
     * Schedule a setTimeout that will be automatically cleared on dispose.
     */
    setTimeout(...args: Parameters<typeof setTimeout>): () => void {
      const timer = setTimeout(...args);
      return api.add(() => clearTimeout(timer));
    },

    /**
     * Schedule a microtask that can be cancelled on dispose.
     */
    microTask(...args: Parameters<typeof microTask>): () => void {
      const task = { current: true };
      microTask(() => {
        if (task.current) {
          args[0]();
        }
      });
      return api.add(() => {
        task.current = false;
      });
    },

    /**
     * Temporarily set a style property, restoring it on dispose.
     */
    style(node: ElementCSSInlineStyle, property: string, value: string): () => void {
      const previous = node.style.getPropertyValue(property);
      Object.assign(node.style, { [property]: value });
      return this.add(() => {
        Object.assign(node.style, { [property]: previous });
      });
    },

    /**
     * Create a nested group of disposables.
     */
    group(cb: (d: typeof api) => void): () => void {
      const d = disposables();
      cb(d);
      return this.add(() => d.dispose());
    },

    /**
     * Add a custom cleanup function.
     * Returns a function that removes and calls this specific cleanup.
     */
    add(cb: () => void): () => void {
      // Ensure we don't add the same callback twice
      if (!_disposables.includes(cb)) {
        _disposables.push(cb);
      }

      return () => {
        const idx = _disposables.indexOf(cb);
        if (idx >= 0) {
          for (const dispose of _disposables.splice(idx, 1)) {
            dispose();
          }
        }
      };
    },

    /**
     * Dispose all registered cleanup functions.
     */
    dispose(): void {
      for (const dispose of _disposables.splice(0)) {
        dispose();
      }
    },
  };

  return api;
}
