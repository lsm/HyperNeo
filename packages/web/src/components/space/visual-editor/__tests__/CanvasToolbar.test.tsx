import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { computeFitToView, CanvasToolbar, ZOOM_STEP, FIT_PADDING } from '../CanvasToolbar';
import { MIN_SCALE, MAX_SCALE } from '../VisualCanvas';
import type { NodePosition, ViewportState } from '../types';

afterEach(() => cleanup());

describe('computeFitToView', () => {
  it('returns default viewport when nodes is empty', () => {
    const result = computeFitToView({}, 800, 600);
    expect(result).toEqual({ offsetX: 0, offsetY: 0, scale: 1 });
  });

  it('centers a single node in the viewport', () => {
    const nodes: NodePosition = { a: { x: 0, y: 0, width: 100, height: 100 } };
    const vw = 800;
    const vh = 600;
    const result = computeFitToView(nodes, vw, vh, 0);

    expect(result.scale).toBe(1);

    const scaledW = 100 * result.scale;
    const scaledH = 100 * result.scale;
    const expectedOffsetX = (vw - scaledW) / 2;
    const expectedOffsetY = (vh - scaledH) / 2;
    expect(result.offsetX).toBeCloseTo(expectedOffsetX);
    expect(result.offsetY).toBeCloseTo(expectedOffsetY);
  });

  it('fits multiple nodes with default padding', () => {
    const nodes: NodePosition = {
      a: { x: 0, y: 0, width: 100, height: 80 },
      b: { x: 200, y: 100, width: 100, height: 80 },
    };
    const vw = 800;
    const vh = 600;
    const result = computeFitToView(nodes, vw, vh, FIT_PADDING);

    const availW = vw - 2 * FIT_PADDING;
    const availH = vh - 2 * FIT_PADDING;
    const expectedScale = Math.min(availW / 300, availH / 180, 1, MAX_SCALE);
    expect(result.scale).toBeCloseTo(expectedScale);

    const nodesW = 300;
    const nodesH = 180;
    const scaledW = nodesW * result.scale;
    const scaledH = nodesH * result.scale;
    const expectedOffsetX = (vw - scaledW) / 2 - 0 * result.scale;
    const expectedOffsetY = (vh - scaledH) / 2 - 0 * result.scale;
    expect(result.offsetX).toBeCloseTo(expectedOffsetX);
    expect(result.offsetY).toBeCloseTo(expectedOffsetY);
  });

  it('clamps scale to MIN_SCALE for tiny viewport', () => {
    const nodes: NodePosition = { a: { x: 0, y: 0, width: 10000, height: 10000 } };
    const result = computeFitToView(nodes, 100, 100, 0);
    expect(result.scale).toBe(MIN_SCALE);
  });

  it('does not scale above 100% for tiny nodes in large viewport', () => {
    const nodes: NodePosition = { a: { x: 0, y: 0, width: 1, height: 1 } };
    const result = computeFitToView(nodes, 1000, 1000, 0);
    expect(result.scale).toBe(1);
  });

  it('fits wide content (limited by width)', () => {
    const nodes: NodePosition = { a: { x: 0, y: 0, width: 400, height: 50 } };
    const result = computeFitToView(nodes, 800, 600, 0);
    expect(result.scale).toBe(1);
  });

  it('fits tall content (limited by height)', () => {
    const nodes: NodePosition = { a: { x: 0, y: 0, width: 50, height: 400 } };
    const result = computeFitToView(nodes, 800, 600, 0);
    expect(result.scale).toBe(1);
  });

  it('handles nodes not starting at origin', () => {
    const nodes: NodePosition = { a: { x: 500, y: 500, width: 100, height: 100 } };
    const vw = 800;
    const vh = 600;
    const result = computeFitToView(nodes, vw, vh, 0);

    expect(result.scale).toBe(1);
    expect(result.offsetX).toBeCloseTo((vw - 100 * result.scale) / 2 - 500 * result.scale);
    expect(result.offsetY).toBeCloseTo((vh - 100 * result.scale) / 2 - 500 * result.scale);
  });
});

function makeViewport(scale = 1, offsetX = 0, offsetY = 0): ViewportState {
  return { scale, offsetX, offsetY };
}

describe('CanvasToolbar', () => {
  it('renders zoom-in, zoom-out, reset, and fit buttons', () => {
    const { getByTestId } = render(
      <CanvasToolbar
        viewport={makeViewport()}
        nodes={{}}
        viewportWidth={800}
        viewportHeight={600}
        onViewportChange={() => {}}
      />
    );
    expect(getByTestId('canvas-toolbar-zoom-in')).toBeTruthy();
    expect(getByTestId('canvas-toolbar-zoom-out')).toBeTruthy();
    expect(getByTestId('canvas-toolbar-reset')).toBeTruthy();
    expect(getByTestId('canvas-toolbar-fit')).toBeTruthy();
  });

  it('displays the current zoom percentage', () => {
    const { getByTestId } = render(
      <CanvasToolbar
        viewport={makeViewport(1.5)}
        nodes={{}}
        viewportWidth={800}
        viewportHeight={600}
        onViewportChange={() => {}}
      />
    );
    expect(getByTestId('canvas-toolbar-reset').textContent).toBe('150%');
  });

  it('zoom-in increases scale by ZOOM_STEP', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <CanvasToolbar
        viewport={makeViewport(1)}
        nodes={{}}
        viewportWidth={800}
        viewportHeight={600}
        onViewportChange={onChange}
      />
    );
    fireEvent.click(getByTestId('canvas-toolbar-zoom-in'));
    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0][0] as ViewportState;
    expect(next.scale).toBeCloseTo(1 + ZOOM_STEP);
  });

  it('zoom-out decreases scale by ZOOM_STEP', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <CanvasToolbar
        viewport={makeViewport(1)}
        nodes={{}}
        viewportWidth={800}
        viewportHeight={600}
        onViewportChange={onChange}
      />
    );
    fireEvent.click(getByTestId('canvas-toolbar-zoom-out'));
    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0][0] as ViewportState;
    expect(next.scale).toBeCloseTo(1 - ZOOM_STEP);
  });

  it('reset returns to scale=1 and offset=0,0', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <CanvasToolbar
        viewport={makeViewport(1.5, 100, 200)}
        nodes={{}}
        viewportWidth={800}
        viewportHeight={600}
        onViewportChange={onChange}
      />
    );
    fireEvent.click(getByTestId('canvas-toolbar-reset'));
    expect(onChange).toHaveBeenCalledWith({ offsetX: 0, offsetY: 0, scale: 1 });
  });

  it('fit-to-view calls onViewportChange with computed fit viewport', () => {
    const onChange = vi.fn();
    const nodes: NodePosition = { a: { x: 0, y: 0, width: 200, height: 150 } };
    const vw = 800;
    const vh = 600;
    const { getByTestId } = render(
      <CanvasToolbar
        viewport={makeViewport(1)}
        nodes={nodes}
        viewportWidth={vw}
        viewportHeight={vh}
        onViewportChange={onChange}
      />
    );
    fireEvent.click(getByTestId('canvas-toolbar-fit'));
    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0][0] as ViewportState;
    const expected = computeFitToView(nodes, vw, vh);
    expect(next.scale).toBeCloseTo(expected.scale);
    expect(next.offsetX).toBeCloseTo(expected.offsetX);
    expect(next.offsetY).toBeCloseTo(expected.offsetY);
  });

  it('zoom-in button is disabled at MAX_SCALE', () => {
    const { getByTestId } = render(
      <CanvasToolbar
        viewport={makeViewport(MAX_SCALE)}
        nodes={{}}
        viewportWidth={800}
        viewportHeight={600}
        onViewportChange={() => {}}
      />
    );
    expect((getByTestId('canvas-toolbar-zoom-in') as HTMLButtonElement).disabled).toBe(true);
  });

  it('zoom-out button is disabled at MIN_SCALE', () => {
    const { getByTestId } = render(
      <CanvasToolbar
        viewport={makeViewport(MIN_SCALE)}
        nodes={{}}
        viewportWidth={800}
        viewportHeight={600}
        onViewportChange={() => {}}
      />
    );
    expect((getByTestId('canvas-toolbar-zoom-out') as HTMLButtonElement).disabled).toBe(true);
  });
});
