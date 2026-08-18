import { microTask } from './micro-task.ts';

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

export function disposables(): DisposablesApi {
  const _disposables: (() => void)[] = [];

  const api: DisposablesApi = {
    addEventListener<TEventName extends keyof WindowEventMap>(
      element: HTMLElement | Window | Document,
      name: TEventName,
      listener: (event: WindowEventMap[TEventName]) => unknown,
      options?: boolean | AddEventListenerOptions
    ): () => void {
      element.addEventListener(name, listener as EventListener, options);
      return api.add(() => element.removeEventListener(name, listener as EventListener, options));
    },

    requestAnimationFrame(...args: Parameters<typeof requestAnimationFrame>): () => void {
      const raf = requestAnimationFrame(...args);
      return api.add(() => cancelAnimationFrame(raf));
    },

    nextFrame(...args: Parameters<typeof requestAnimationFrame>): () => void {
      return api.requestAnimationFrame(() => {
        return api.requestAnimationFrame(...args);
      });
    },

    setTimeout(...args: Parameters<typeof setTimeout>): () => void {
      const timer = setTimeout(...args);
      return api.add(() => clearTimeout(timer));
    },

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

    style(node: ElementCSSInlineStyle, property: string, value: string): () => void {
      const previous = node.style.getPropertyValue(property);
      Object.assign(node.style, { [property]: value });
      return this.add(() => {
        Object.assign(node.style, { [property]: previous });
      });
    },

    group(cb: (d: typeof api) => void): () => void {
      const d = disposables();
      cb(d);
      return this.add(() => d.dispose());
    },

    add(cb: () => void): () => void {
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

    dispose(): void {
      for (const dispose of _disposables.splice(0)) {
        dispose();
      }
    },
  };

  return api;
}
