import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { locale } from '../../../lib/i18n/index.ts';
import { ContentDisclosureControl } from '../ContentDisclosureControl.tsx';

afterEach(() => {
  cleanup();
  locale.value = 'en';
});

describe('ContentDisclosureControl voice labels', () => {
  it('offers an icon-only presentation without losing its name or button semantics', () => {
    const onToggle = vi.fn();
    render(
      <ContentDisclosureControl
        iconOnly
        expanded={false}
        onToggle={onToggle}
        aria-label="Show more"
      />
    );
    const control = screen.getByRole('button', { name: 'Show more' });
    expect(control.querySelector('.sr-only')?.textContent).toBe('more');
    expect(control.classList.contains('text-fg-faint')).toBe(true);
    expect(control.style.float).toBe('');
    control.click();
    expect(onToggle).toHaveBeenCalledOnce();
  });
  it.each([
    ['en', false, 'Show details: Example task', 'more'],
    ['en', true, 'Hide details: Example task', 'less'],
    ['en', false, 'Details', 'more'],
    ['en', true, 'Details', 'less'],
    ['en', false, 'Show more', 'more'],
    ['en', true, 'Show less', 'less'],
    ['zh-Hans', false, '详情', '更多'],
    ['zh-Hans', true, '详情', '收起'],
  ] as const)(
    'includes the visible word in its %s expanded=%s accessible name (%s)',
    (language, expanded, context, word) => {
      locale.value = language;
      render(
        <ContentDisclosureControl expanded={expanded} onToggle={vi.fn()} aria-label={context} />
      );
      const control = screen.getByRole('button', { name: new RegExp(word, 'i') });
      expect(control.textContent).toContain(word);
      expect(control.getAttribute('aria-label')).toContain(context);
    }
  );
});
