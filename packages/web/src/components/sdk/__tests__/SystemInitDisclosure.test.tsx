import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import { SDKSystemMessage } from '../SDKSystemMessage.tsx';
import { SDKMessageRenderer } from '../SDKMessageRenderer.tsx';

afterEach(cleanup);
const init = () =>
  ({
    claude_code_version: 'synthetic',
    output_style: 'default',
    skills: [],
    plugins: [],
    type: 'system',
    subtype: 'init',
    uuid: crypto.randomUUID(),
    session_id: 'synthetic',
    model: 'synthetic-init-model',
    cwd: '/synthetic/project',
    permissionMode: 'default',
    tools: ['Read'],
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    apiKeySource: 'user',
  }) as Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;

describe('SDK initialization disclosures', () => {
  it.each([
    { label: 'Session Started', title: 'Session Started', pill: false },
    { label: 'Session details', title: 'synthetic-init-model', pill: true },
  ])('uses the shared explicit control for $label', ({ label, title, pill }) => {
    const message = init();
    const view = render(
      pill ? (
        <SDKMessageRenderer message={message} taskContext />
      ) : (
        <SDKSystemMessage message={message} />
      )
    );
    fireEvent.click(view.getByText(title, { exact: true }));
    const more = view.getByRole('button', { name: `more — ${label}`, exact: true });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.focus();
    fireEvent.click(more);
    const less = view.getByRole('button', { name: `less — ${label}`, exact: true });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(less);
    expect(view.getByText('/synthetic/project')).toBeTruthy();
    fireEvent.click(view.getByText('/synthetic/project'));
    expect(less.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(less);
    expect(document.activeElement).toBe(
      view.getByRole('button', { name: `more — ${label}`, exact: true })
    );
  });

  it('keeps initialization hidden in normal session rendering', () => {
    const view = render(<SDKMessageRenderer message={init()} />);
    expect(view.container.textContent).toBe('');
    expect(view.queryByRole('button')).toBeNull();
  });
});
