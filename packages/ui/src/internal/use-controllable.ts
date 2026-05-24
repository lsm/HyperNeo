import { useCallback, useRef, useState } from 'preact/hooks';

export function useControllable<T>(
  controlledValue: T | undefined,
  onChange?: (value: T) => void,
  defaultValue?: T
): [T, (value: T) => void] {
  const isControlled = controlledValue !== undefined;
  const [internalValue, setInternalValue] = useState<T>(defaultValue as T);

  const value = isControlled ? controlledValue : internalValue;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setValue = useCallback(
    (newValue: T) => {
      if (!isControlled) {
        setInternalValue(newValue);
      }
      onChangeRef.current?.(newValue);
    },
    [isControlled]
  );

  return [value as T, setValue];
}
