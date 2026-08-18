import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { VisualCanvas, applyWheelEvent, MIN_SCALE, MAX_SCALE } from '../VisualCanvas';
import { screenToCanvas, canvasToScreen } from '../types';
import type { NodePosition, ViewportState } from '../types';

afterEach(() => cleanup());

function windowMouseMove(clientX: number, clientY: number) {
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY }));
}

function windowMouseUp() {
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

function renderCanvas(initial: ViewportState = { offsetX: 0, offsetY: 0, scale: 1 }) {
  const changes: ViewportState[] = [];

  function Wrapper() {
    const [vp, setVp] = useState<ViewportState>(initial);
    return (
      <VisualCanvas
        viewportState={vp}
        onViewportChange={(next) => {
          changes.push(next);
          setVp(next);
        }}
      >
        <div data-testid="child-node">Hello</div>
      </VisualCanvas>
    );
  }

  const result = render(<Wrapper />);
  return { ...result, changes };
}

describe('VisualCanvas', () => {
  it('renders children inside the transform layer', () => {
    const { getByTestId } = renderCanvas();
    expect(getByTestId('child-node').textContent).toBe('Hello');
    const transformEl = getByTestId('visual-canvas-transform');
    expect(transformEl.contains(getByTestId('child-node'))).toBe(true);
  });

  it('applies the correct CSS transform from ViewportState', () => {
    const { getByTestId } = renderCanvas({ offsetX: 50, offsetY: -20, scale: 1.5 });
    const transformEl = getByTestId('visual-canvas-transform');
    expect(transformEl.style.transform).toBe('translate(50px, -20px) scale(1.5)');
  });

  it('pans via wheel event (no ctrlKey) - deltaX/deltaY update offsets', () => {
    const { getByTestId, changes } = renderCanvas({ offsetX: 0, offsetY: 0, scale: 1 });
    const container = getByTestId('visual-canvas');

    fireEvent.wheel(container, { deltaX: 30, deltaY: 10 });

    expect(changes.length).toBeGreaterThan(0);
    const last = changes[changes.length - 1];
    expect(last.offsetX).toBe(-30);
    expect(last.offsetY).toBe(-10);
    expect(last.scale).toBe(1);
  });

  it('pans via left-drag on empty canvas without needing spacebar', () => {
    const { getByTestId, changes } = renderCanvas({ offsetX: 10, offsetY: 20, scale: 1 });
    const container = getByTestId('visual-canvas');

    fireEvent.mouseDown(container, { button: 0, clientX: 100, clientY: 80 });
    windowMouseMove(140, 115);
    windowMouseUp();

    expect(changes.length).toBeGreaterThan(0);
    const last = changes[changes.length - 1];
    expect(last.offsetX).toBe(50);
    expect(last.offsetY).toBe(55);
    expect(last.scale).toBe(1);
  });

  it('pans via single-finger touch drag on empty canvas', () => {
    const { getByTestId, changes } = renderCanvas({ offsetX: 10, offsetY: 20, scale: 1 });
    const container = getByTestId('visual-canvas');

    fireEvent.touchStart(container, {
      touches: [{ identifier: 1, clientX: 100, clientY: 80 }],
    });
    fireEvent.touchMove(container, {
      touches: [{ identifier: 1, clientX: 140, clientY: 115 }],
    });
    fireEvent.touchEnd(container, { touches: [] });

    expect(changes.length).toBeGreaterThan(0);
    const last = changes[changes.length - 1];
    expect(last.offsetX).toBe(50);
    expect(last.offsetY).toBe(55);
    expect(last.scale).toBe(1);
  });

  it('renders SVG overlay layer inside the transform layer', () => {
    const { getByTestId } = renderCanvas();
    const transformEl = getByTestId('visual-canvas-transform');
    const svgEl = getByTestId('visual-canvas-svg');
    expect(svgEl).toBeTruthy();
    expect(svgEl.tagName.toLowerCase()).toBe('svg');
    expect(transformEl.contains(svgEl)).toBe(true);
  });

  it('SVG layer has position:absolute and pointer-events:none', () => {
    const { getByTestId } = renderCanvas();
    const svgEl = getByTestId('visual-canvas-svg') as HTMLElement;
    expect(svgEl.style.position).toBe('absolute');
    expect(svgEl.style.pointerEvents).toBe('none');
  });

  it('SVG layer is the first child of the transform layer', () => {
    const { getByTestId } = renderCanvas();
    const transformEl = getByTestId('visual-canvas-transform');
    expect(transformEl.firstElementChild?.tagName.toLowerCase()).toBe('svg');
  });

  it('renders edge content via edgeLayer render prop', () => {
    const vp: ViewportState = { offsetX: 0, offsetY: 0, scale: 1 };
    const changes: ViewportState[] = [];

    function Wrapper() {
      const [viewport, setViewport] = useState<ViewportState>(vp);
      return (
        <VisualCanvas
          viewportState={viewport}
          onViewportChange={(next) => {
            changes.push(next);
            setViewport(next);
          }}
          edgeLayer={() => <circle data-testid="edge-circle" cx="10" cy="10" r="5" />}
        >
          <div>child</div>
        </VisualCanvas>
      );
    }

    const { getByTestId } = render(<Wrapper />);
    const circle = getByTestId('edge-circle');
    expect(circle).toBeTruthy();
    expect(circle.tagName.toLowerCase()).toBe('circle');
    const svgEl = getByTestId('visual-canvas-svg');
    expect(svgEl.contains(circle)).toBe(true);
  });

  it('passes current viewport state to edgeLayer render prop', () => {
    const capturedViewports: ViewportState[] = [];
    const initialVp: ViewportState = { offsetX: 42, offsetY: -10, scale: 1.5 };

    function Wrapper() {
      const [viewport, setViewport] = useState<ViewportState>(initialVp);
      return (
        <VisualCanvas
          viewportState={viewport}
          onViewportChange={setViewport}
          edgeLayer={(receivedVp) => {
            capturedViewports.push(receivedVp);
            return null;
          }}
        />
      );
    }

    render(<Wrapper />);
    expect(capturedViewports.length).toBeGreaterThan(0);
    const last = capturedViewports[capturedViewports.length - 1];
    expect(last.offsetX).toBe(42);
    expect(last.offsetY).toBe(-10);
    expect(last.scale).toBe(1.5);
  });

  it('sizes the transform layer from node bounds so the SVG edge layer has canvas space', () => {
    const nodes: NodePosition = {
      a: { x: 500, y: 700, width: 160, height: 80 },
    };

    const { getByTestId } = render(
      <VisualCanvas
        viewportState={{ offsetX: 0, offsetY: 0, scale: 1 }}
        onViewportChange={() => {}}
        nodes={nodes}
      >
        <div data-testid="child-node">Hello</div>
      </VisualCanvas>
    );

    const transformEl = getByTestId('visual-canvas-transform') as HTMLElement;
    expect(transformEl.style.width).toBe('780px');
    expect(transformEl.style.height).toBe('900px');

    const svgEl = getByTestId('visual-canvas-svg') as HTMLElement;
    expect(svgEl.style.width).toBe('100%');
    expect(svgEl.style.height).toBe('100%');
  });
});

describe('applyWheelEvent', () => {
  const base: ViewportState = { offsetX: 0, offsetY: 0, scale: 1 };

  it('pans when isZoom=false', () => {
    const result = applyWheelEvent(base, 30, 10, false);
    expect(result.offsetX).toBe(-30);
    expect(result.offsetY).toBe(-10);
    expect(result.scale).toBe(1);
  });

  it('zooms in (negative deltaY) when isZoom=true', () => {
    const result = applyWheelEvent(base, 0, -100, true, 0, 0);
    expect(result.scale).toBeGreaterThan(1);
  });

  it('zooms out (positive deltaY) when isZoom=true', () => {
    const result = applyWheelEvent(base, 0, 100, true, 0, 0);
    expect(result.scale).toBeLessThan(1);
  });

  it('clamps scale to MIN_SCALE on aggressive zoom-out', () => {
    const result = applyWheelEvent({ ...base, scale: 0.3 }, 0, 10000, true, 0, 0);
    expect(result.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(result.scale).toBe(MIN_SCALE);
  });

  it('clamps scale to MAX_SCALE on aggressive zoom-in', () => {
    const result = applyWheelEvent({ ...base, scale: 1.9 }, 0, -10000, true, 0, 0);
    expect(result.scale).toBeLessThanOrEqual(MAX_SCALE);
    expect(result.scale).toBe(MAX_SCALE);
  });

  it('zooms toward cursor position', () => {
    const vp: ViewportState = { offsetX: 0, offsetY: 0, scale: 1 };
    const cursorX = 100;
    const cursorY = 100;
    const result = applyWheelEvent(vp, 0, -100, true, cursorX, cursorY);

    const canvasBefore = {
      x: (cursorX - vp.offsetX) / vp.scale,
      y: (cursorY - vp.offsetY) / vp.scale,
    };
    const screenAfter = {
      x: canvasBefore.x * result.scale + result.offsetX,
      y: canvasBefore.y * result.scale + result.offsetY,
    };
    expect(screenAfter.x).toBeCloseTo(cursorX);
    expect(screenAfter.y).toBeCloseTo(cursorY);
  });
});

describe('screenToCanvas / canvasToScreen', () => {
  it('are inverse functions at scale=1, no offset', () => {
    const vp: ViewportState = { offsetX: 0, offsetY: 0, scale: 1 };
    const screen = { x: 100, y: 200 };
    const canvas = screenToCanvas(screen, vp);
    const back = canvasToScreen(canvas, vp);
    expect(back.x).toBeCloseTo(screen.x);
    expect(back.y).toBeCloseTo(screen.y);
  });

  it('are inverse functions with offset and scale', () => {
    const vp: ViewportState = { offsetX: 50, offsetY: -30, scale: 1.5 };
    const screen = { x: 300, y: 150 };
    const canvas = screenToCanvas(screen, vp);
    const back = canvasToScreen(canvas, vp);
    expect(back.x).toBeCloseTo(screen.x);
    expect(back.y).toBeCloseTo(screen.y);
  });

  it('screenToCanvas maps correctly', () => {
    const vp: ViewportState = { offsetX: 100, offsetY: 50, scale: 2 };
    const canvas = screenToCanvas({ x: 200, y: 150 }, vp);
    expect(canvas.x).toBeCloseTo(50);
    expect(canvas.y).toBeCloseTo(50);
  });

  it('canvasToScreen maps correctly', () => {
    const vp: ViewportState = { offsetX: 100, offsetY: 50, scale: 2 };
    const screen = canvasToScreen({ x: 50, y: 50 }, vp);
    expect(screen.x).toBeCloseTo(200);
    expect(screen.y).toBeCloseTo(150);
  });
});
