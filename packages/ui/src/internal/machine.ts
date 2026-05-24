import { DefaultMap } from './default-map.ts';
import { disposables, type Disposables } from './disposables.ts';
import { env } from './env.ts';

/**
 * Subscriber interface for slice-based state subscriptions.
 * Uses unknown to allow storing subscribers with different slice types.
 */
interface Subscriber<State> {
  selector: (state: Readonly<State>) => unknown;
  callback: (state: unknown) => void;
  current: unknown;
}

/**
 * Abstract base class for state machines.
 *
 * Machines provide centralized state management with:
 * - Slice-based subscriptions for efficient updates
 * - Event-specific subscriptions
 * - Shallow equality checks to prevent unnecessary re-renders
 * - Automatic SSR cleanup
 *
 * @example
 * ```ts
 * interface State {
 *   count: number;
 * }
 *
 * type Event = { type: 'increment' } | { type: 'decrement' };
 *
 * class CounterMachine extends Machine<State, Event> {
 *   constructor() {
 *     super({ count: 0 });
 *   }
 *
 *   reduce(state: State, event: Event): State {
 *     switch (event.type) {
 *       case 'increment':
 *         return { ...state, count: state.count + 1 };
 *       case 'decrement':
 *         return { ...state, count: state.count - 1 };
 *     }
 *   }
 * }
 * ```
 */
export abstract class Machine<State, Event extends { type: number | string }> {
  #state: State = {} as State;
  #eventSubscribers = new DefaultMap<Event['type'], Set<(state: State, event: Event) => void>>(
    () => new Set()
  );
  #subscribers: Set<Subscriber<State>> = new Set();

  /**
   * Disposables for cleanup of side effects.
   * Also used internally for SSR cleanup.
   */
  disposables: Disposables = disposables();

  /**
   * Creates a new Machine instance.
   *
   * @param initialState - The initial state of the machine
   */
  constructor(initialState: State) {
    this.#state = initialState;

    if (env.isServer) {
      // Cleanup any disposables that were registered on the server-side
      this.disposables.microTask(() => {
        this.dispose();
      });
    }
  }

  /**
   * Dispose of all resources and subscriptions.
   */
  dispose(): void {
    this.disposables.dispose();
  }

  /**
   * Get the current state of the machine.
   */
  get state(): Readonly<State> {
    return this.#state;
  }

  /**
   * Abstract reduce method that subclasses must implement.
   *
   * @param state - The current state
   * @param event - The event to process
   * @returns The new state (should be a new object if changed)
   */
  abstract reduce(state: Readonly<State>, event: Event): Readonly<State>;

  /**
   * Subscribe to changes in a specific slice of state.
   *
   * The selector extracts a slice of state, and the callback is only called
   * when that slice changes (as determined by shallow equality).
   *
   * @param selector - Function to extract the slice of interest
   * @param callback - Function to call when the slice changes
   * @returns Unsubscribe function
   *
   * @example
   * ```ts
   * machine.subscribe(
   *   (state) => state.count,
   *   (count) => console.log('Count changed:', count)
   * );
   * ```
   */
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

  /**
   * Subscribe to a specific event type.
   *
   * @param type - The event type to listen for
   * @param callback - Function to call when the event occurs
   * @returns Unsubscribe function
   *
   * @example
   * ```ts
   * machine.on('push', (state, event) => {
   *   console.log('Item pushed:', event.id);
   * });
   * ```
   */
  on<T extends Event['type']>(
    type: T,
    callback: (state: State, event: Extract<Event, { type: T }>) => void
  ): () => void {
    if (env.isServer) return () => {};

    // Cast to the general callback type for storage
    this.#eventSubscribers.get(type).add(callback as (state: State, event: Event) => void);
    return this.disposables.add(() => {
      this.#eventSubscribers.get(type).delete(callback as (state: State, event: Event) => void);
    });
  }

  /**
   * Dispatch an event to the machine.
   *
   * This will:
   * 1. Call reduce() to compute the new state
   * 2. If state changed, notify slice subscribers (with shallow equality check)
   * 3. Notify event subscribers
   *
   * @param event - The event to dispatch
   */
  send(event: Event): void {
    const newState = this.reduce(this.#state, event);
    if (newState === this.#state) return; // No change

    this.#state = newState;

    // Notify slice subscribers
    for (const subscriber of this.#subscribers) {
      const slice = subscriber.selector(this.#state);
      if (shallowEqual(subscriber.current, slice)) continue;

      subscriber.current = slice;
      subscriber.callback(slice);
    }

    // Notify event subscribers
    for (const callback of this.#eventSubscribers.get(event.type)) {
      callback(this.#state, event);
    }
  }
}

/**
 * Compare two values for shallow equality.
 *
 * Returns true if:
 * - They are the same reference (Object.is)
 * - They are both arrays with equal elements
 * - They are both Maps or Sets with equal entries
 * - They are both plain objects with equal entries
 *
 * @param a - First value to compare
 * @param b - Second value to compare
 * @returns true if the values are shallowly equal
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  // Exact same reference
  if (Object.is(a, b)) return true;

  // Must be some type of object
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }

  // Arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return compareEntries(a[Symbol.iterator](), b[Symbol.iterator]());
  }

  // Map and Set
  if ((a instanceof Map && b instanceof Map) || (a instanceof Set && b instanceof Set)) {
    if (a.size !== b.size) return false;
    return compareEntries(a.entries(), b.entries());
  }

  // Plain objects
  if (isPlainObject(a) && isPlainObject(b)) {
    return compareEntries(
      Object.entries(a)[Symbol.iterator](),
      Object.entries(b)[Symbol.iterator]()
    );
  }

  // Not sure how to compare other types of objects
  return false;
}

/**
 * Compare two iterators for equality by advancing them in lockstep.
 */
function compareEntries(a: IterableIterator<unknown>, b: IterableIterator<unknown>): boolean {
  while (true) {
    const aResult = a.next();
    const bResult = b.next();

    if (aResult.done && bResult.done) return true;
    if (aResult.done || bResult.done) return false;

    if (!Object.is(aResult.value, bResult.value)) return false;
  }
}

/**
 * Check if a value is a plain object (created by {} or Object.create(null)).
 */
function isPlainObject<T>(value: T): value is T & Record<keyof T, unknown> {
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
