import type { JSX } from 'preact';
import { createElement } from 'preact';

interface HiddenProps {
  name?: string;
  value?: string | string[];
  form?: string;
}

export function Hidden({ name, value, form }: HiddenProps): JSX.Element | null {
  if (!name) return null;

  if (Array.isArray(value)) {
    return createElement(
      'span',
      null,
      ...value.map((v, i) =>
        createElement('input', {
          key: `${name}-${i}`,
          type: 'hidden',
          name,
          value: v,
          form,
        })
      )
    );
  }

  return createElement('input', {
    type: 'hidden',
    name,
    value: value ?? '',
    form,
  });
}

Hidden.displayName = 'Hidden';
