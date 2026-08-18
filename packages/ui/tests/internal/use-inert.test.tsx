import { act, cleanup, render } from '@testing-library/preact';
import { useRef } from 'preact/hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { useInert } from '../../src/internal/use-inert.ts';

afterEach(() => {
  cleanup();
});

function _InertContainer({
  enabled = true,
  children,
}: {
  enabled?: boolean;
  children?: preact.ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useInert(ref, enabled);
  return <div ref={ref}>{children}</div>;
}

describe('useInert', () => {
  it('sets inert attribute on sibling elements when enabled', async () => {
    const parent = document.createElement('div');
    const sibling1 = document.createElement('div');
    sibling1.id = 'sibling1';
    const sibling2 = document.createElement('div');
    sibling2.id = 'sibling2';
    parent.appendChild(sibling1);
    parent.appendChild(sibling2);
    document.body.appendChild(parent);

    const containerDiv = document.createElement('div');
    containerDiv.id = 'container-slot';
    parent.appendChild(containerDiv);

    function TestComp() {
      const ref = useRef<HTMLDivElement | null>(null);
      useInert(ref, true);
      return (
        <div ref={ref} id="inert-container">
          Content
        </div>
      );
    }

    render(<TestComp />, { container: containerDiv });
    await act(async () => {});

    document.body.removeChild(parent);
  });

  it('marks siblings inert and restores on unmount', async () => {
    const parent = document.createElement('div');
    const sib1 = document.createElement('section');
    sib1.id = 'inert-sib1';
    const sib2 = document.createElement('section');
    sib2.id = 'inert-sib2';
    parent.appendChild(sib1);
    parent.appendChild(sib2);
    document.body.appendChild(parent);

    function TestComp() {
      const ref = useRef<HTMLDivElement | null>(null);
      useInert(ref, true);
      return (
        <div ref={ref} id="focus-container">
          Focus here
        </div>
      );
    }

    const { unmount } = render(<TestComp />, { container: parent });
    await act(async () => {});

    expect(sib1.hasAttribute('inert')).toBe(true);
    expect(sib2.hasAttribute('inert')).toBe(true);

    unmount();
    await act(async () => {});

    expect(sib1.hasAttribute('inert')).toBe(false);
    expect(sib2.hasAttribute('inert')).toBe(false);

    document.body.removeChild(parent);
  });

  it('does not set inert on the container element itself', async () => {
    const parent = document.createElement('div');
    const sib = document.createElement('div');
    sib.id = 'non-self-sib';
    parent.appendChild(sib);
    document.body.appendChild(parent);

    function TestComp() {
      const ref = useRef<HTMLDivElement | null>(null);
      useInert(ref, true);
      return (
        <div ref={ref} id="self-container">
          Self
        </div>
      );
    }

    render(<TestComp />, { container: parent });
    await act(async () => {});

    const selfContainer = document.getElementById('self-container');
    expect(selfContainer?.hasAttribute('inert')).toBe(false);

    document.body.removeChild(parent);
  });

  it('does nothing when disabled', async () => {
    const parent = document.createElement('div');
    const sib = document.createElement('div');
    sib.id = 'disabled-sib';
    parent.appendChild(sib);
    document.body.appendChild(parent);

    function TestComp() {
      const ref = useRef<HTMLDivElement | null>(null);
      useInert(ref, false);
      return (
        <div ref={ref} id="disabled-container">
          Container
        </div>
      );
    }

    render(<TestComp />, { container: parent });
    await act(async () => {});

    expect(sib.hasAttribute('inert')).toBe(false);

    document.body.removeChild(parent);
  });

  it('cleanup logic correctly restores inert attributes', () => {
    const parent = document.createElement('div');
    const sib = document.createElement('div');
    sib.setAttribute('inert', 'preexisting');
    parent.appendChild(sib);
    document.body.appendChild(parent);

    const siblings: HTMLElement[] = [];
    const originalInert: (string | null)[] = [];

    for (const child of Array.from(parent.children)) {
      if (child instanceof HTMLElement) {
        siblings.push(child);
        originalInert.push(child.getAttribute('inert'));
        child.setAttribute('inert', '');
      }
    }

    expect(sib.getAttribute('inert')).toBe('');

    siblings.forEach((s, i) => {
      const original = originalInert[i];
      if (original === null) {
        s.removeAttribute('inert');
      } else {
        s.setAttribute('inert', original);
      }
    });

    expect(sib.getAttribute('inert')).toBe('preexisting');

    document.body.removeChild(parent);
  });
});
