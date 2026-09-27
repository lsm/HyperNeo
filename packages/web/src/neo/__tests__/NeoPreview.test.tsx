import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { NeoPreview } from '../NeoPreview.tsx';

afterEach(() => cleanup());

function openConcern(title: string) {
  const concerns = screen.getByLabelText('Your concerns') as HTMLDetailsElement;
  if (!concerns.open) {
    fireEvent.click(within(concerns).getByText(/things I’m holding for you/));
  }
  fireEvent.click(within(concerns).getByRole('button', { name: title }));
}

function returnToNeo() {
  fireEvent.click(screen.getByRole('button', { name: '← Back to Neo' }));
}

describe('NeoPreview', () => {
  it('labels the experience as sample-only with no live agents', () => {
    render(<NeoPreview />);

    const label = screen.getByText('Interaction preview').closest('p');

    expect(label?.textContent).toContain('Sample situations. No agents are running.');
    expect(label?.textContent).toContain('Changes reset on reload.');
    expect(screen.getByText('Preview only · stays on this page')).toBeTruthy();

    const concerns = screen.getByLabelText('Your concerns') as HTMLDetailsElement;
    expect(concerns.open).toBe(false);
    expect(within(concerns).getByText('3 things I’m holding for you')).toBeTruthy();
  });

  it('drills into a concern and returns to the Neo overview', () => {
    render(<NeoPreview />);

    openConcern('Finding our next home');

    expect(screen.getByRole('heading', { level: 1, name: 'Finding our next home' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Concern context' })).toBeTruthy();

    returnToNeo();

    expect(
      screen.getByRole('heading', { level: 1, name: 'One thing needs your call.' })
    ).toBeTruthy();
    expect((screen.getByLabelText('Your concerns') as HTMLDetailsElement).open).toBe(false);
  });

  it('keeps added context isolated to its concern', () => {
    render(<NeoPreview />);

    openConcern('Finding our next home');
    const note = 'The new place must allow cats.';
    fireEvent.input(screen.getByRole('textbox'), { target: { value: note } });
    fireEvent.click(screen.getByRole('button', { name: /Add context/ }));

    expect(
      within(screen.getByRole('region', { name: 'Concern context' })).getByText(note)
    ).toBeTruthy();

    returnToNeo();
    openConcern('The September launch');

    expect(screen.queryByText(note)).toBeNull();

    returnToNeo();
    openConcern('Finding our next home');

    expect(
      within(screen.getByRole('region', { name: 'Concern context' })).getByText(note)
    ).toBeTruthy();
  });

  it('preserves independent drafts while moving between concerns and the overview', () => {
    render(<NeoPreview />);

    openConcern('The September launch');
    fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Launch draft that is not submitted' },
    });
    returnToNeo();

    fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Overview draft that is not submitted' },
    });
    openConcern('Finding our next home');
    fireEvent.input(screen.getByRole('textbox'), {
      target: { value: 'Home draft that is not submitted' },
    });
    returnToNeo();

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'Overview draft that is not submitted'
    );

    openConcern('The September launch');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'Launch draft that is not submitted'
    );

    returnToNeo();
    openConcern('Finding our next home');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'Home draft that is not submitted'
    );
  });

  it('does not submit whitespace-only input', () => {
    render(<NeoPreview />);

    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.input(input, { target: { value: '   \n  ' } });
    const submit = screen.getByRole('button', { name: /Try an ask/ }) as HTMLButtonElement;

    expect(submit.disabled).toBe(true);
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(
      screen.getByRole('heading', { level: 1, name: 'One thing needs your call.' })
    ).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('');
    expect(input.value).toBe('   \n  ');
  });

  it('holds an overview ask only inside the preview', () => {
    render(<NeoPreview />);

    const ask = 'Help me prepare for the school meeting';
    fireEvent.input(screen.getByRole('textbox'), { target: { value: ask } });
    fireEvent.click(screen.getByRole('button', { name: /Try an ask/ }));

    expect(screen.getByRole('heading', { level: 1, name: ask })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(
      'Held in this preview only. Neo has not delegated any work.'
    );
    expect(screen.getByText('No work linked yet.')).toBeTruthy();

    returnToNeo();

    expect(
      within(screen.getByLabelText('Your concerns')).getByText('4 things I’m holding for you')
    ).toBeTruthy();
    openConcern(ask);
    expect(screen.getByRole('heading', { level: 1, name: ask })).toBeTruthy();
  });

  it('keeps a simulated decision in the launch context across navigation', () => {
    render(<NeoPreview />);

    fireEvent.click(screen.getByRole('button', { name: 'Give it until Monday' }));

    expect(
      screen.getByRole('heading', { level: 1, name: 'That’s one less loose end.' })
    ).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(
      'Decision recorded in this preview. No schedule or task was changed.'
    );

    fireEvent.click(screen.getByRole('button', { name: 'See the updated context →' }));
    const decision = 'Preview decision: Give testing until Monday.';
    expect(
      within(screen.getByRole('region', { name: 'Concern context' })).getByText(decision)
    ).toBeTruthy();

    returnToNeo();
    fireEvent.click(screen.getByRole('button', { name: 'From your launch context ↗' }));

    expect(
      within(screen.getByRole('region', { name: 'Concern context' })).getByText(decision)
    ).toBeTruthy();
  });
});
