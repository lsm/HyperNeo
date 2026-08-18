import { DefaultMap } from './default-map.ts';
import { disposables, type Disposables } from './disposables.ts';
import { env } from './env.ts';

interface Subscriber<State> {
  selector: (state: Readonly<State>) => unknown;
  callback: (state: unknown) => void;
  current: unknown;
}

export abstract class Machine<State, Event extends { type: number | string }> {
  #state: State = {} as State;
  #eventSubscribers = new DefaultMap<Event['type'], Set<(state: State, event: Event) => void>>(
    () => new Set()
  );
  #subscribers: Set<Subscriber<State>> = new Set();

  disposables: Disposables = disposables();

  constructor(initialState: State) {
    this.#state = initialState;

    if (env.isServer) {
      this.disposables.microTask(() => {
        this.dispose();
      });
    }
  }

  dispose(): void {
    this.disposables.dispose();
  }

  get state(): Readonly<State> {
    return this.#state;
  }

  abstract reduce(state: Readonly<State>, event: Event): Readonly<State>;

  subscribe<Slice>(
    selector: (state: Readonly<State>) => Slice,
    callback: (state: Slice) => void
  ): () => void {
    if (env.isServer) return () => {};

    const subscriber: Subscriber<State> = {
      selector: selector as (state: Readonly<State>) => unknown,
      callback: callback as (state: unknown) => void,
      current: selector(this.#state),
    };
    this.#subscribers.add(subscriber);

    return this.disposables.add(() => {
      this.#subscribers.delete(subscriber);
    });
  }

  on<T extends Event['type']>(
    type: T,
    callback: (state: State, event: Extract<Event, { type: T }>) => void
  ): () => void {
    if (env.isServer) return () => {};

    this.#eventSubscribers.get(type).add(callback as (state: State, event: Event) => void);
    return this.disposables.add(() => {
      this.#eventSubscribers.get(type).delete(callback as (state: State, event: Event) => void);
    });
  }

  send(event: Event): void {
    const newState = this.reduce(this.#state, event);
    if (newState === this.#state) return;

    this.#state = newState;

    for (const subscriber of this.#subscribers) {
      const slice = subscriber.selector(this.#state);
      if (shallowEqual(subscriber.current, slice)) continue;

      subscriber.current = slice;
      subscriber.callback(slice);
    }

    for (const callback of this.#eventSubscribers.get(event.type)) {
      callback(this.#state, event);
    }
  }
}

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return compareEntries(a[Symbol.iterator](), b[Symbol.iterator]());
  }

  if ((a instanceof Map && b instanceof Map) || (a instanceof Set && b instanceof Set)) {
    if (a.size !== b.size) return false;
    return compareEntries(a.entries(), b.entries());
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    return compareEntries(
      Object.entries(a)[Symbol.iterator](),
      Object.entries(b)[Symbol.iterator]()
    );
  }

  return false;
}

function compareEntries(a: IterableIterator<unknown>, b: IterableIterator<unknown>): boolean {
  while (true) {
    const aResult = a.next();
    const bResult = b.next();

    if (aResult.done && bResult.done) return true;
    if (aResult.done || bResult.done) return false;

    if (!Object.is(aResult.value, bResult.value)) return false;
  }
}

function isPlainObject<T>(value: T): value is T & Record<keyof T, unknown> {
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
