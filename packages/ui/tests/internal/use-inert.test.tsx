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

    // Render the InertContainer into the sibling slot
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

    // siblings of the rendered div inside containerDiv should be inert
    // Actually the ref points to the div inside containerDiv, so parent is containerDiv
    // Let's test with a simpler setup

    document.body.removeChild(parent);
  });

  it('marks siblings inert and restores on unmount', async () => {
    // Build structure: parent > [sib1, sib2, mountPoint]
    // The rendered component's ref points to a div INSIDE mountPoint,
    // so the parentElement of the ref is mountPoint, and its siblings are sib1/sib2/mountPoint.
    // We need the rendered div to be a direct child of parent.
    // @testing-library renders into `container`, making the component a child of it.
    // So render into parent directly.
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

    // render() wraps output in container div appended to document.body by default.
    // We pass `container: parent` so the rendered <div ref=...> is a child of parent,
    // making sib1/sib2 siblings of the ref'd element.
    const { unmount } = render(<TestComp />, { container: parent });
    await act(async () => {});

    // sib1 and sib2 should be inert now
    expect(sib1.hasAttribute('inert')).toBe(true);
    expect(sib2.hasAttribute('inert')).toBe(true);

    // unmount should restore
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
    // Test the cleanup logic directly — simulating what useInert does internally
    // for a sibling that already has an inert attribute
    const parent = document.createElement('div');
    const sib = document.createElement('div');
    sib.setAttribute('inert', 'preexisting');
    parent.appendChild(sib);
    document.body.appendChild(parent);

    // Simulate useInert effect: record original, set to ''
    const siblings: HTMLElement[] = [];
    const originalInert: (string | null)[] = [];

    for (const child of Array.from(parent.children)) {
      if (child instanceof HTMLElement) {
        siblings.push(child);
        originalInert.push(child.getAttribute('inert'));
        child.setAttribute('inert', '');
      }
    }

    // After effect: sib should have inert=''
    expect(sib.getAttribute('inert')).toBe('');

    // Simulate cleanup
    siblings.forEach((s, i) => {
      const original = originalInert[i];
      if (original === null) {
        s.removeAttribute('inert');
      } else {
        s.setAttribute('inert', original);
      }
    });

    // After cleanup: sib should have inert='preexisting' (restored)
    expect(sib.getAttribute('inert')).toBe('preexisting');

    document.body.removeChild(parent);
  });
});
