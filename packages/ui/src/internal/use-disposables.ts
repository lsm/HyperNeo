import { useEffect, useState } from 'preact/hooks';
import { disposables, type Disposables } from './disposables.ts';

export function useDisposables(): Disposables {
  const [d] = useState(disposables);
  useEffect(() => () => d.dispose(), [d]);
  return d;
}
