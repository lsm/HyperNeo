import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

export enum State {
  Open = 0,
  Closed = 1,
}

export const OpenClosedContext = createContext<State | null>(null);
OpenClosedContext.displayName = 'OpenClosedContext';

export function useOpenClosed(): State | null {
  return useContext(OpenClosedContext);
}
