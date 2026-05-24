import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

const CloseContext = createContext<(() => void) | null>(null);
CloseContext.displayName = 'CloseContext';

export { CloseContext };

export function useClose(): () => void {
  const close = useContext(CloseContext);
  if (!close) {
    throw new Error('useClose() must be used within a Dialog or Popover');
  }
  return close;
}
