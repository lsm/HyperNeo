import { cleanup, render as tlRender } from '@testing-library/preact';
import { Fragment } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeProps, render } from '../../src/internal/render.ts';
import { Features } from '../../src/internal/types.ts';

afterEach(() => {
  cleanup();
});

const baseArgs = {
  slot: {},
  name: 'TestComponent',
};

describe('render', () => {
  it('renders a simple element', () => {
    const vnode = render({
      ...baseArgs,
      ourProps: {},
      theirProps: { id: 'test-el' },
      defaultTag: 'div',
    });
    if (!vnode) throw new Error('expected vnode');
    const { container } = tlRender(vnode);
    expect(container.querySelector('#test-el')).not.toBeNull();
  });

  it('returns null when not visible and no features', () => {
    const result = render({
      ...baseArgs,
      ourProps: {},
      theirProps: {},
      defaultTag: 'div',
      visible: false,
    });
    expect(result).toBeNull();
  });

  it('renders hidden element with Features.Static when static=true and not visible', () => {
    const vnode = render({
      ...baseArgs,
      ourProps: {},
      theirProps: { static: true },
      defaultTag: 'div',
      features: Features.Static,
      visible: false,
    });
    if (!vnode) throw new Error('expected vnode');
    const { container } = tlRender(vnode);
    const el = container.querySelector('div');
    expect(el).not.toBeNull();
    expect(el?.hidden).toBe(true);
  });

  it('returns null when Features.Static but static=false and not visible', () => {
    const result = render({
      ...baseArgs,
      ourProps: {},
      theirProps: { static: false },
      defaultTag: 'div',
      features: Features.Static,
      visible: false,
    });
    expect(result).toBeNull();
  });

  it('returns null when Features.RenderStrategy with unmount=true and not visible', () => {
    const result = render({
      ...baseArgs,
      ourProps: {},
      theirProps: { unmount: true },
      defaultTag: 'div',
      features: Features.RenderStrategy,
      visible: false,
    });
    expect(result).toBeNull();
  });

  it('renders hidden element when Features.RenderStrategy with unmount=false and not visible', () => {
    const vnode = render({
      ...baseArgs,
      ourProps: {},
      theirProps: { unmount: false },
      defaultTag: 'div',
      features: Features.RenderStrategy,
      visible: false,
    });
    if (!vnode) throw new Error('expected vnode');
    const { container } = tlRender(vnode);
    const el = container.querySelector('div');
    expect(el).not.toBeNull();
    expect(el?.hidden).toBe(true);
  });

  it('renders with Fragment as component (no extra props → Fragment)', () => {
    const vnode = render({
      ...baseArgs,
      ourProps: { as: Fragment },
      theirProps: {},
      defaultTag: 'div',
    });
    const { container } = tlRender(<div>{vnode}</div>);
    expect(container.firstChild).not.toBeNull();
  });

  it('wraps Fragment in span when extra non-key props are present', () => {
    const vnode = render({
      ...baseArgs,
      ourProps: { as: Fragment, 'data-extra': 'value' },
      theirProps: {},
      defaultTag: 'div',
    });
    const { container } = tlRender(<div>{vnode}</div>);
    const span = container.querySelector('span');
    expect(span).not.toBeNull();
  });

  it('supports render prop children (function as children)', () => {
    const childFn = vi.fn((_slot: Record<string, unknown>) => <span id="child-fn">rendered</span>);
    const vnode = render({
      ...baseArgs,
      ourProps: {},
      theirProps: { children: childFn },
      defaultTag: 'div',
      slot: { open: true },
    });
    if (!vnode) throw new Error('expected vnode');
    const { container } = tlRender(vnode);
    expect(container.querySelector('#child-fn')).not.toBeNull();
    expect(childFn).toHaveBeenCalledWith({ open: true });
  });

  it('strips static and unmount props from visible render', () => {
    const vnode = render({
      ...baseArgs,
      ourProps: {},
      theirProps: { static: true, unmount: false, id: 'clean-el' },
      defaultTag: 'div',
      visible: true,
    });
    if (!vnode) throw new Error('expected vnode');
    const { container } = tlRender(vnode);
    const el = container.querySelector('#clean-el');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('static')).toBeNull();
    expect(el?.getAttribute('unmount')).toBeNull();
  });

  it('adds data attributes from slot booleans', () => {
    const vnode = render({
      ...baseArgs,
      ourProps: {},
      theirProps: { id: 'slot-attrs' },
      defaultTag: 'div',
      slot: { open: true, disabled: false } as Record<string, unknown>,
    });
    if (!vnode) throw new Error('expected vnode');
    const { container } = tlRender(vnode);
    const el = container.querySelector('#slot-attrs');
    expect(el?.getAttribute('data-open')).toBe('');
    expect(el?.getAttribute('data-disabled')).toBeNull();
  });
});

describe('mergeProps', () => {
  it('returns empty object for no arguments', () => {
    expect(mergeProps()).toEqual({});
  });

  it('returns the single props object as-is', () => {
    const props = { id: 'test', className: 'foo' };
    expect(mergeProps(props)).toEqual(props);
  });

  it('merges className and class into class', () => {
    const result = mergeProps({ className: 'foo' }, { class: 'bar' });
    expect(result.class).toBe('foo bar');
    expect(result.className).toBeUndefined();
  });

  it('merges two className values with a space', () => {
    const result = mergeProps({ className: 'foo' }, { className: 'bar' });
    expect(result.class).toBe('foo bar');
  });

  it('chains two event handlers when merging two prop objects', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const result = mergeProps({ onClick: handler1 }, { onClick: handler2 });
    const merged = result.onClick as (...args: unknown[]) => void;
    merged('event-arg');
    expect(handler1).toHaveBeenCalledWith('event-arg');
    expect(handler2).toHaveBeenCalledWith('event-arg');
  });

  it('merges style objects', () => {
    const result = mergeProps(
      { style: { color: 'red', fontSize: '12px' } },
      { style: { fontSize: '14px', fontWeight: 'bold' } }
    );
    expect(result.style).toEqual({ color: 'red', fontSize: '14px', fontWeight: 'bold' });
  });

  it('last value wins for non-special props', () => {
    const result = mergeProps({ id: 'first' }, { id: 'second' });
    expect(result.id).toBe('second');
  });

  it('handles missing class/className gracefully', () => {
    const result = mergeProps({ id: 'a' }, { class: 'my-class' });
    expect(result.class).toBe('my-class');
  });

  it('merges multiple props objects by applying mergeProps iteratively', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();
    const step1 = mergeProps({ onFocus: h1 }, { onFocus: h2 });
    const step2 = mergeProps(step1, { onFocus: h3 });
    (step2.onFocus as (...args: unknown[]) => void)();
    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
    expect(h3).toHaveBeenCalled();
  });
});
