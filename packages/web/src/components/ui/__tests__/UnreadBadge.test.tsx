import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { UnreadBadge } from '../UnreadBadge';

afterEach(cleanup);

describe('UnreadBadge', () => {
  it.each([1, 3, 100, 150])(
    'shows an accessible dot without visible count for %s messages',
    (count) => {
      const { container, getByRole } = render(<UnreadBadge count={count} />);
      expect(
        getByRole('img', { name: `${count} unread ${count === 1 ? 'message' : 'messages'}` })
      ).toBeTruthy();
      expect(container.textContent).toBe('');
    }
  );

  it.each([0, -1])('does not render for %s messages', (count) => {
    const { container } = render(<UnreadBadge count={count} />);
    expect(container.firstChild).toBeNull();
  });
});
