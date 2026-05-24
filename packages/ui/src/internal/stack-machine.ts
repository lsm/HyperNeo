import { Machine, shallowEqual } from './machine.ts';
import { match } from './match.ts';
import { DefaultMap } from './default-map.ts';

/**
 * Scope type for stack machines.
 * Use null for the global scope or a string for named scopes.
 */
type Scope = string | null;

/**
 * Unique identifier for items in the stack.
 */
type Id = string;

/**
 * State interface for the stack machine.
 */
interface State {
  stack: Id[];
}

/**
 * Action types for stack machine operations.
 */
export enum ActionTypes {
  Push,
  Pop,
}

/**
 * Action union type for stack machine.
 */
export type Actions = { type: ActionTypes.Push; id: Id } | { type: ActionTypes.Pop; id: Id };

/**
 * Reducers for each action type.
 */
const reducers: {
  [P in ActionTypes]: (state: State, action: Extract<Actions, { type: P }>) => State;
} = {
  [ActionTypes.Push](state, action) {
    const id = action.id;
    const idx = state.stack.indexOf(id);

    // Already in the stack, move it to the top
    if (idx !== -1) {
      const copy = state.stack.slice();
      copy.splice(idx, 1);
      copy.push(id);

      return { ...state, stack: copy };
    }

    // Not in the stack, add it to the top
    return { ...state, stack: [...state.stack, id] };
  },

  [ActionTypes.Pop](state, action) {
    const id = action.id;
    const idx = state.stack.indexOf(id);
    if (idx === -1) return state; // Not in the stack

    const copy = state.stack.slice();
    copy.splice(idx, 1);

    return { ...state, stack: copy };
  },
};

/**
 * Stack machine for tracking nested components.
 *
 * This is used for modal dialogs, popovers, menus, etc. where you need to know
 * which component is on "top" for proper z-indexing, event handling, and focus management.
 *
 * @example
 * ```ts
 * const stack = stackMachines.get(null); // Get global stack
 *
 * // When a dialog opens
 * stack.actions.push('dialog-1');
 *
 * // Check if it's top-most
 * const isTop = stack.selectors.isTop(stack.state, 'dialog-1');
 *
 * // When dialog closes
 * stack.actions.pop('dialog-1');
 * ```
 */
class StackMachine extends Machine<State, Actions> {
  /**
   * Create a new StackMachine instance.
   */
  static new(): StackMachine {
    return new StackMachine({ stack: [] });
  }

  /**
   * Reduce state based on action.
   */
  reduce(state: Readonly<State>, action: Actions): State {
    // Cast reducers to match the match function's expected signature
    return match(
      action.type,
      reducers as Record<ActionTypes, State | ((...args: unknown[]) => State)>,
      state,
      action
    ) as State;
  }

  /**
   * Action methods for dispatching events.
   */
  actions = {
    /**
     * Push an item onto the stack.
     * If already present, moves it to the top.
     */
    push: (id: Id): void => this.send({ type: ActionTypes.Push, id }),

    /**
     * Pop an item from the stack.
     * Does nothing if not present.
     */
    pop: (id: Id): void => this.send({ type: ActionTypes.Pop, id }),
  };

  /**
   * Selector methods for querying state.
   */
  selectors = {
    /**
     * Check if an item is at the top of the stack.
     */
    isTop: (state: State, id: Id): boolean => state.stack[state.stack.length - 1] === id,

    /**
     * Check if an item is anywhere in the stack.
     */
    inStack: (state: State, id: Id): boolean => state.stack.includes(id),
  };
}

/**
 * Global registry of stack machines by scope.
 *
 * Use null scope for the global stack, or a string for component-specific stacks.
 *
 * @example
 * ```ts
 * // Global stack
 * const globalStack = stackMachines.get(null);
 *
 * // Component-specific stack
 * const modalStack = stackMachines.get('modals');
 * ```
 */
export const stackMachines = new DefaultMap<Scope, StackMachine>(() => StackMachine.new());

// Re-export shallowEqual for consumers
export { shallowEqual };
