import type { ComponentChildren, JSX } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ContentDisclosureControl } from './ContentDisclosureControl.tsx';

type Props = {
  label: string;
  summary: ComponentChildren;
} & Omit<JSX.IntrinsicElements['details'], 'children' | 'open' | 'onToggle'> & {
    children: ComponentChildren | ((control: ComponentChildren) => ComponentChildren);
  };

export function NativeContentDisclosure({ label, summary, children, ...attributes }: Props) {
  const [open, setOpen] = useState(false);
  const element = useRef<HTMLDetailsElement>(null);
  const restoreFocus = useRef(false);
  const id = useId();
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    element.current
      ?.querySelector<HTMLButtonElement>(`button[aria-controls="${id}"]`)
      ?.focus({ preventScroll: true });
  }, [open, id]);
  const control = (
    <ContentDisclosureControl
      expanded={open}
      aria-label={label}
      aria-controls={id}
      onToggle={() => {
        restoreFocus.current = true;
        setOpen(!open);
      }}
    />
  );
  return (
    <details
      {...attributes}
      ref={element}
      open={open}
      aria-label={label}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        role="presentation"
        tabIndex={-1}
        onClick={(event) => event.preventDefault()}
        class="flow-root min-h-9 cursor-text list-none select-text rounded-md px-3 py-2"
      >
        {summary}
        {!open && control}
      </summary>
      <div id={id}>
        {typeof children === 'function' ? (
          children(open ? control : null)
        ) : (
          <>
            {children}
            {open && <div class="flow-root px-3 pb-2">{control}</div>}
          </>
        )}
      </div>
    </details>
  );
}
