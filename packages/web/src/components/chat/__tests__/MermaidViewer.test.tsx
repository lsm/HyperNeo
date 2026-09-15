// @ts-nocheck
import { render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvedTheme } from '../../../lib/theme.ts';
import { MermaidFigureToolbar, MermaidViewerOverlay } from '../MermaidViewer';

const { mermaidInitializeMock, mermaidRunMock } = vi.hoisted(() => ({
  mermaidInitializeMock: vi.fn(),
  mermaidRunMock: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: mermaidInitializeMock,
    parse: vi.fn(),
    run: mermaidRunMock,
  },
}));

const STAGE_WIDTH = 500;
const STAGE_HEIGHT = 400;
const SVG_WIDTH = 200;
const SVG_HEIGHT = 100;
const FIT_SCALE = Math.min((STAGE_WIDTH - 48) / SVG_WIDTH, (STAGE_HEIGHT - 48) / SVG_HEIGHT);
const FIT_X = (STAGE_WIDTH - SVG_WIDTH * FIT_SCALE) / 2;
const FIT_Y = (STAGE_HEIGHT - SVG_HEIGHT * FIT_SCALE) / 2;

const getOverlay = () => document.querySelector('.mermaid-overlay');
const getStage = () => document.querySelector('.mermaid-stage');
const getContent = () => document.querySelector('.mermaid-stage-content');

const mockStageRect = () => {
  const stage = getStage();
  return vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: STAGE_WIDTH,
    bottom: STAGE_HEIGHT,
    width: STAGE_WIDTH,
    height: STAGE_HEIGHT,
    toJSON: () => ({}),
  });
};

const readTransform = () => {
  const style = getContent().getAttribute('style') || '';
  const match = style.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/);
  if (!match) return null;
  return {
    x: Number.parseFloat(match[1]),
    y: Number.parseFloat(match[2]),
    scale: Number.parseFloat(match[3]),
  };
};

const pointerDown = (target: Element, pointerId: number, x: number, y: number) => {
  target.dispatchEvent(
    new PointerEvent('pointerdown', { pointerId, clientX: x, clientY: y, button: 0, bubbles: true })
  );
};

const pointerMove = (target: Element, pointerId: number, x: number, y: number) => {
  target.dispatchEvent(
    new PointerEvent('pointermove', { pointerId, clientX: x, clientY: y, bubbles: true })
  );
};

const pointerUp = (target: Element, pointerId: number, x: number, y: number) => {
  target.dispatchEvent(
    new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y, bubbles: true })
  );
};

const wheel = (
  target: Element,
  options: {
    deltaY: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
    clientX?: number;
    clientY?: number;
  }
) => {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY: options.deltaY,
  });
  for (const key of ['ctrlKey', 'metaKey', 'clientX', 'clientY'] as const) {
    Object.defineProperty(event, key, { value: options[key] });
  }
  target.dispatchEvent(event);
};

const click = (target: Element) => {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

const renderOverlayAndWait = async (source = 'graph TD\n  A-->B') => {
  const onClose = vi.fn();
  const result = render(<MermaidViewerOverlay source={source} onClose={onClose} />);
  mockStageRect();
  await waitFor(() => {
    expect(readTransform()?.scale).toBeCloseTo(FIT_SCALE, 5);
  });
  return { ...result, onClose };
};

describe('MermaidViewer', () => {
  beforeEach(() => {
    mermaidInitializeMock.mockReset();
    mermaidRunMock.mockReset();
    mermaidRunMock.mockImplementation(async ({ nodes }) => {
      for (const node of nodes) {
        node.innerHTML = `<svg viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}"></svg>`;
      }
    });
  });

  afterEach(() => {
    document.body.style.overflow = '';
    const overlay = getOverlay();
    if (overlay) {
      click(overlay.querySelector('button[title="Close"]'));
    }
    resolvedTheme.value = 'light';
  });

  describe('Figure Toolbar', () => {
    it('should render an always-visible expand control sized for touch', () => {
      const { container } = render(<MermaidFigureToolbar source="graph TD\n  A-->B" />);
      const button = container.querySelector('button[title="Expand diagram"]');
      expect(button).toBeTruthy();
      expect(button?.className).toContain('h-10');
      expect(button?.className).toContain('w-10');
      const toolbar = container.querySelector('.mermaid-figure-toolbar');
      expect(toolbar?.className).not.toContain('opacity-0');
      expect(toolbar?.className).not.toContain('group-hover');
      expect(getOverlay()).toBeFalsy();
    });

    it('should open the fullscreen overlay outside the card', async () => {
      const { container } = render(<MermaidFigureToolbar source="graph TD\n  A-->B" />);
      click(container.querySelector('button[title="Expand diagram"]'));
      await waitFor(() => {
        expect(getOverlay()).toBeTruthy();
      });
      expect(container.querySelector('.mermaid-overlay')).toBeFalsy();
      expect(getOverlay()?.getAttribute('role')).toBe('dialog');
      expect(getOverlay()?.getAttribute('aria-modal')).toBe('true');
    });

    it('should render the diagram into the overlay stage', async () => {
      const { container } = render(<MermaidFigureToolbar source="graph TD\n  A-->B" />);
      click(container.querySelector('button[title="Expand diagram"]'));
      await waitFor(() => {
        expect(getStage()?.querySelector('svg')?.getAttribute('viewBox')).toBe(
          `0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`
        );
      });
      expect(mermaidRunMock).toHaveBeenCalled();
    });

    it('should close the overlay via the X button and restore body scroll', async () => {
      document.body.style.overflow = 'auto';
      const { container } = render(<MermaidFigureToolbar source="graph TD\n  A-->B" />);
      click(container.querySelector('button[title="Expand diagram"]'));
      await waitFor(() => {
        expect(getOverlay()).toBeTruthy();
      });
      expect(document.body.style.overflow).toBe('hidden');
      click(getOverlay().querySelector('button[title="Close"]'));
      await waitFor(() => {
        expect(getOverlay()).toBeFalsy();
      });
      expect(document.body.style.overflow).toBe('auto');
      document.body.style.overflow = '';
    });

    it('should keep the viewer mounted when the figure toolbar unmounts', async () => {
      const { container, unmount } = render(<MermaidFigureToolbar source="graph TD\n  A-->B" />);
      click(container.querySelector('button[title="Expand diagram"]'));
      await waitFor(() => {
        expect(getOverlay()).toBeTruthy();
      });
      unmount();
      expect(getOverlay()).toBeTruthy();
      click(getOverlay().querySelector('button[title="Close"]'));
      await waitFor(() => {
        expect(getOverlay()).toBeFalsy();
      });
    });

    it('should re-render the diagram in place when the theme changes', async () => {
      const { container } = render(<MermaidFigureToolbar source="graph TD\n  A-->B" />);
      click(container.querySelector('button[title="Expand diagram"]'));
      await waitFor(() => {
        expect(getStage()?.querySelector('svg')).toBeTruthy();
      });
      resolvedTheme.value = 'dark';
      await waitFor(() => {
        expect(mermaidInitializeMock).toHaveBeenCalledWith(
          expect.objectContaining({ theme: 'dark' })
        );
      });
      expect(getOverlay()).toBeTruthy();
      expect(getStage()?.querySelector('svg')).toBeTruthy();
    });

    it('should preserve pan and zoom across a theme change', async () => {
      const { container } = render(<MermaidFigureToolbar source="graph TD\n  A-->B" />);
      click(container.querySelector('button[title="Expand diagram"]'));
      mockStageRect();
      await waitFor(() => {
        expect(readTransform()?.scale).toBeCloseTo(FIT_SCALE, 5);
      });
      click(getOverlay().querySelector('button[title="Zoom in"]'));
      await waitFor(() => {
        expect(getOverlay().querySelector('.mermaid-zoom-level')?.textContent).toBe('125%');
      });
      const zoomed = readTransform();
      resolvedTheme.value = 'dark';
      await waitFor(() => {
        expect(mermaidInitializeMock).toHaveBeenCalledWith(
          expect.objectContaining({ theme: 'dark' })
        );
      });
      await waitFor(() => {
        expect(getStage()?.querySelector('svg')).toBeTruthy();
      });
      expect(readTransform()?.scale).toBeCloseTo(zoomed.scale, 5);
      expect(getOverlay().querySelector('.mermaid-zoom-level')?.textContent).toBe('125%');
    });

    it('should restore focus to the trigger when the viewer closes', async () => {
      const { container } = render(<MermaidFigureToolbar source="graph TD\n  A-->B" />);
      const expand = container.querySelector('button[title="Expand diagram"]');
      expand?.focus();
      click(expand);
      await waitFor(() => {
        expect(getOverlay()).toBeTruthy();
      });
      expect(getOverlay().contains(document.activeElement)).toBe(true);
      click(getOverlay().querySelector('button[title="Close"]'));
      await waitFor(() => {
        expect(getOverlay()).toBeFalsy();
      });
      expect(document.activeElement).toBe(expand);
    });
  });

  describe('Overlay Zoom Controls', () => {
    it('should lock body scroll and use touch-sized controls', async () => {
      document.body.style.overflow = 'auto';
      await renderOverlayAndWait();
      expect(document.body.style.overflow).toBe('hidden');
      getOverlay()
        .querySelectorAll('.mermaid-overlay button')
        .forEach((button) => {
          expect(button.className).toContain('h-10');
          expect(button.className).toContain('w-10');
        });
      document.body.style.overflow = '';
    });

    it('should fit the diagram to the stage on open', async () => {
      await renderOverlayAndWait();
      const transform = readTransform();
      expect(transform?.scale).toBeCloseTo(FIT_SCALE, 5);
      expect(transform?.x).toBeCloseTo(FIT_X, 5);
      expect(transform?.y).toBeCloseTo(FIT_Y, 5);
      expect(getOverlay().querySelector('.mermaid-zoom-level')?.textContent).toBe('100%');
    });

    it('should zoom in and out from the stage center', async () => {
      await renderOverlayAndWait();
      click(getOverlay().querySelector('button[title="Zoom in"]'));
      await waitFor(() => {
        expect(readTransform()?.scale).toBeCloseTo(FIT_SCALE * 1.25, 5);
      });
      expect(readTransform()?.x).toBeCloseTo(STAGE_WIDTH / 2 - (STAGE_WIDTH / 2 - FIT_X) * 1.25, 3);
      expect(readTransform()?.y).toBeCloseTo(
        STAGE_HEIGHT / 2 - (STAGE_HEIGHT / 2 - FIT_Y) * 1.25,
        3
      );
      expect(getOverlay().querySelector('.mermaid-zoom-level')?.textContent).toBe('125%');

      click(getOverlay().querySelector('button[title="Zoom out"]'));
      await waitFor(() => {
        expect(readTransform()?.scale).toBeCloseTo(FIT_SCALE, 5);
      });
      expect(getOverlay().querySelector('.mermaid-zoom-level')?.textContent).toBe('100%');
    });

    it('should reset the transform to fit with the fit button', async () => {
      await renderOverlayAndWait();
      const stage = getStage();
      pointerDown(stage, 1, 100, 100);
      pointerMove(stage, 1, 160, 140);
      pointerUp(stage, 1, 160, 140);
      click(getOverlay().querySelector('button[title="Zoom in"]'));
      await waitFor(() => {
        expect(readTransform()?.scale).toBeGreaterThan(FIT_SCALE);
      });

      click(getOverlay().querySelector('button[title="Fit to screen"]'));
      await waitFor(() => {
        expect(readTransform()?.scale).toBeCloseTo(FIT_SCALE, 5);
      });
      expect(readTransform()?.x).toBeCloseTo(FIT_X, 5);
      expect(readTransform()?.y).toBeCloseTo(FIT_Y, 5);
    });

    it('should zoom with ctrl+wheel around the cursor and ignore plain wheel', async () => {
      await renderOverlayAndWait();
      const stage = getStage();
      wheel(stage, { ctrlKey: true, deltaY: -100, clientX: 250, clientY: 200 });
      const factor = Math.exp(0.15);
      await waitFor(() => {
        expect(readTransform()?.scale).toBeCloseTo(FIT_SCALE * factor, 3);
      });
      expect(readTransform()?.x).toBeCloseTo(
        250 - (250 - FIT_X) * ((FIT_SCALE * factor) / FIT_SCALE),
        3
      );

      const before = readTransform();
      wheel(stage, { deltaY: -100, clientX: 250, clientY: 200 });
      expect(readTransform()).toEqual(before);
    });

    it('should zoom with cmd+wheel', async () => {
      await renderOverlayAndWait();
      const before = readTransform();
      wheel(getStage(), { metaKey: true, deltaY: -100, clientX: 250, clientY: 200 });
      await waitFor(() => {
        expect(readTransform()?.scale).toBeGreaterThan(before.scale);
      });
    });

    it('should refit the diagram when the stage resizes', async () => {
      render(<MermaidViewerOverlay source="graph TD\n  A-->B" onClose={vi.fn()} />);
      const spy = mockStageRect();
      await waitFor(() => {
        expect(readTransform()?.scale).toBeCloseTo(FIT_SCALE, 5);
      });
      spy.mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 800,
        bottom: 400,
        width: 800,
        height: 400,
        toJSON: () => ({}),
      });
      window.dispatchEvent(new Event('resize'));
      const wideFit = Math.min((800 - 48) / SVG_WIDTH, (400 - 48) / SVG_HEIGHT);
      await waitFor(() => {
        expect(readTransform()?.scale).toBeCloseTo(wideFit, 5);
      });
      expect(readTransform()?.x).toBeCloseTo((800 - SVG_WIDTH * wideFit) / 2, 3);
    });

    it('should clamp zoom-out to the fitted scale for very large diagrams', async () => {
      mermaidRunMock.mockImplementationOnce(async ({ nodes }) => {
        for (const node of nodes) {
          node.innerHTML = '<svg viewBox="0 0 20000 100"></svg>';
        }
      });
      render(<MermaidViewerOverlay source="graph TD\n  A-->B" onClose={vi.fn()} />);
      mockStageRect();
      const hugeFit = (STAGE_WIDTH - 48) / 20000;
      expect(hugeFit).toBeLessThan(0.05);
      await waitFor(() => {
        expect(readTransform()?.scale).toBeCloseTo(hugeFit, 6);
      });
      click(getOverlay().querySelector('button[title="Zoom out"]'));
      await waitFor(() => {
        expect(getOverlay().querySelector('.mermaid-zoom-level')?.textContent).toBe('100%');
      });
      expect(readTransform()?.scale).toBeCloseTo(hugeFit, 6);
      click(getOverlay().querySelector('button[title="Zoom in"]'));
      await waitFor(() => {
        expect(readTransform()?.scale).toBeGreaterThan(hugeFit);
      });
    });
  });

  describe('Overlay Pan and Pinch', () => {
    it('should pan the diagram by dragging with one pointer', async () => {
      await renderOverlayAndWait();
      const stage = getStage();
      pointerDown(stage, 1, 100, 100);
      pointerMove(stage, 1, 140, 120);
      pointerUp(stage, 1, 140, 120);
      await waitFor(() => {
        expect(readTransform()?.x).toBeCloseTo(FIT_X + 40, 5);
        expect(readTransform()?.y).toBeCloseTo(FIT_Y + 20, 5);
      });
      expect(readTransform()?.scale).toBeCloseTo(FIT_SCALE, 5);
    });

    it('should ignore drags that start with a non-primary mouse button', async () => {
      await renderOverlayAndWait();
      const stage = getStage();
      stage.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 1,
          clientX: 100,
          clientY: 100,
          button: 2,
          pointerType: 'mouse',
          bubbles: true,
        })
      );
      pointerMove(stage, 1, 140, 120);
      expect(readTransform()?.x).toBeCloseTo(FIT_X, 5);
      expect(readTransform()?.y).toBeCloseTo(FIT_Y, 5);
    });

    it('should zoom with a two-finger pinch', async () => {
      await renderOverlayAndWait();
      const stage = getStage();
      pointerDown(stage, 1, 100, 100);
      pointerDown(stage, 2, 200, 100);
      pointerMove(stage, 2, 300, 100);
      await waitFor(() => {
        expect(readTransform()?.scale).toBeCloseTo(FIT_SCALE * 2, 3);
      });
      expect(readTransform()?.x).toBeCloseTo(200 - (150 - FIT_X) * 2, 3);
      expect(readTransform()?.y).toBeCloseTo(100 - (100 - FIT_Y) * 2, 3);

      pointerUp(stage, 1, 100, 100);
      pointerUp(stage, 2, 300, 100);
    });

    it('should pan with the two remaining fingers after a pinch lifts', async () => {
      await renderOverlayAndWait();
      const stage = getStage();
      pointerDown(stage, 1, 100, 100);
      pointerDown(stage, 2, 200, 100);
      pointerMove(stage, 2, 300, 100);
      await waitFor(() => {
        expect(readTransform()?.scale).toBeCloseTo(FIT_SCALE * 2, 3);
      });
      const pinched = readTransform();
      pointerUp(stage, 2, 300, 100);
      pointerMove(stage, 1, 160, 130);
      await waitFor(() => {
        expect(readTransform()?.x).toBeCloseTo(pinched.x + 60, 3);
        expect(readTransform()?.y).toBeCloseTo(pinched.y + 30, 3);
      });
      expect(readTransform()?.scale).toBeCloseTo(FIT_SCALE * 2, 3);
    });

    it('should rebase the pinch baseline when the active pointer pair changes', async () => {
      await renderOverlayAndWait();
      const stage = getStage();
      pointerDown(stage, 1, 100, 100);
      pointerDown(stage, 2, 200, 100);
      pointerMove(stage, 2, 300, 100);
      await waitFor(() => {
        expect(readTransform()?.scale).toBeCloseTo(FIT_SCALE * 2, 3);
      });
      pointerDown(stage, 3, 150, 200);
      pointerUp(stage, 1, 100, 100);
      expect(readTransform()?.scale).toBeCloseTo(FIT_SCALE * 2, 3);
      const baseDistance = Math.hypot(300 - 150, 100 - 200);
      const nextDistance = Math.hypot(400 - 150, 100 - 200);
      pointerMove(stage, 2, 400, 100);
      await waitFor(() => {
        expect(readTransform()?.scale).toBeCloseTo(
          FIT_SCALE * 2 * (nextDistance / baseDistance),
          3
        );
      });
      pointerUp(stage, 2, 400, 100);
      pointerUp(stage, 3, 150, 200);
    });
  });

  describe('Overlay Close and Lifecycle', () => {
    it('should close on Escape and restore body scroll on unmount', async () => {
      document.body.style.overflow = 'auto';
      const { onClose, unmount } = await renderOverlayAndWait();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
      expect(getOverlay()).toBeFalsy();
      expect(document.body.style.overflow).toBe('auto');
      document.body.style.overflow = '';
    });

    it('should consume Escape before underlying overlays see it', async () => {
      const underlying = vi.fn();
      document.addEventListener('keydown', underlying);
      const { onClose } = await renderOverlayAndWait();
      getOverlay().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      expect(underlying).not.toHaveBeenCalled();
      document.removeEventListener('keydown', underlying);
    });

    it('should move keyboard focus into the overlay on open', async () => {
      await renderOverlayAndWait();
      expect(getOverlay().contains(document.activeElement)).toBe(true);
    });

    it('should close via the X button', async () => {
      const { onClose } = await renderOverlayAndWait();
      click(getOverlay().querySelector('button[title="Close"]'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should keep showing the source when mermaid produces no svg', async () => {
      mermaidRunMock.mockResolvedValue(undefined);
      render(<MermaidViewerOverlay source="graph TD\n  A-->B" onClose={vi.fn()} />);
      await waitFor(() => {
        expect(getOverlay()).toBeTruthy();
      });
      await waitFor(() => {
        expect(getStage()?.querySelector('.mermaid')?.textContent).toContain('A-->B');
      });
    });

    it('should restore the source when a mermaid render rejects mid-render', async () => {
      mermaidRunMock.mockImplementationOnce(async ({ nodes }) => {
        for (const node of nodes) {
          node.innerHTML = '';
        }
        throw new Error('render failed');
      });
      render(<MermaidViewerOverlay source="graph TD\n  A-->B" onClose={vi.fn()} />);
      mockStageRect();
      await waitFor(() => {
        expect(getStage()?.querySelector('.mermaid')?.textContent).toContain('A-->B');
      });
    });

    it('should place unmeasured fallback content at a padded origin', async () => {
      mermaidRunMock.mockResolvedValue(undefined);
      render(<MermaidViewerOverlay source="graph TD\n  A-->B" onClose={vi.fn()} />);
      mockStageRect();
      await waitFor(() => {
        expect(getStage()?.querySelector('.mermaid')?.textContent).toContain('A-->B');
      });
      const transform = readTransform();
      expect(transform?.x).toBe(24);
      expect(transform?.y).toBe(24);
      expect(transform?.scale).toBe(1);
    });
  });
});
