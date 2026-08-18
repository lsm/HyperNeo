import { Machine, shallowEqual } from './machine.ts';
import { match } from './match.ts';
import { DefaultMap } from './default-map.ts';

type Scope = string | null;

type Id = string;

interface State {
  stack: Id[];
}

export enum ActionTypes {
  Push,
  Pop,
}

export type Actions = { type: ActionTypes.Push; id: Id } | { type: ActionTypes.Pop; id: Id };

const reducers: {
  [P in ActionTypes]: (state: State, action: Extract<Actions, { type: P }>) => State;
} = {
  [ActionTypes.Push](state, action) {
    const id = action.id;
    const idx = state.stack.indexOf(id);

    if (idx !== -1) {
      const copy = state.stack.slice();
      copy.splice(idx, 1);
      copy.push(id);

      return { ...state, stack: copy };
    }

    return { ...state, stack: [...state.stack, id] };
  },

  [ActionTypes.Pop](state, action) {
    const id = action.id;
    const idx = state.stack.indexOf(id);
    if (idx === -1) return state;

    const copy = state.stack.slice();
    copy.splice(idx, 1);

    return { ...state, stack: copy };
  },
};

class StackMachine extends Machine<State, Actions> {
  static new(): StackMachine {
    return new StackMachine({ stack: [] });
  }

  reduce(state: Readonly<State>, action: Actions): State {
    return match(
      action.type,
      reducers as Record<ActionTypes, State | ((...args: unknown[]) => State)>,
      state,
      action
    ) as State;
  }

  actions = {
    push: (id: Id): void => this.send({ type: ActionTypes.Push, id }),

    pop: (id: Id): void => this.send({ type: ActionTypes.Pop, id }),
  };

  selectors = {
    isTop: (state: State, id: Id): boolean => state.stack[state.stack.length - 1] === id,

    inStack: (state: State, id: Id): boolean => state.stack.includes(id),
  };
}

export const stackMachines = new DefaultMap<Scope, StackMachine>(() => StackMachine.new());

export { shallowEqual };
