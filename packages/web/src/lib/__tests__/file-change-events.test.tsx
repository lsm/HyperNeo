import 'preact/compat';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(cleanup);

it('dispatches a native change for file inputs after compatibility portals load', () => {
  const received = vi.fn();
  const file = new File(['fictional'], 'fictional.txt', { type: 'text/plain' });
  render(
    <input
      type="file"
      aria-label="Fictional file"
      onChange={(event) => received(event.type, Array.from(event.currentTarget.files ?? []))}
    />
  );
  fireEvent.change(screen.getByLabelText('Fictional file'), { target: { files: [file] } });
  expect(received).toHaveBeenCalledExactlyOnceWith('change', [file]);
});

it('retains compatibility input events for text controls', () => {
  const received = vi.fn();
  render(
    <input
      type="text"
      aria-label="Fictional text"
      onChange={(event) => received(event.type, event.currentTarget.value)}
    />
  );
  fireEvent.change(screen.getByLabelText('Fictional text'), { target: { value: 'fictional' } });
  expect(received).toHaveBeenCalledExactlyOnceWith('input', 'fictional');
});
