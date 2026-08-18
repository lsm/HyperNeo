import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Description,
  Field,
  FieldError,
  Fieldset,
  Input,
  Label,
  Legend,
  Select,
  Textarea,
} from '../src/mod.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Field', () => {
  it('should render a div by default', () => {
    const { container } = render(<Field>content</Field>);
    expect(container.querySelector('div')).not.toBeNull();
  });

  it('should render with custom as prop', () => {
    const { container } = render(<Field as="section">content</Field>);
    expect(container.querySelector('section')).not.toBeNull();
  });

  it('should render children', () => {
    render(
      <Field>
        <span>child</span>
      </Field>
    );
    expect(screen.getByText('child')).not.toBeNull();
  });

  it('should pass disabled to children via context', () => {
    render(
      <Field disabled>
        <Input />
      </Field>
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('should have data-disabled when disabled', () => {
    const { container } = render(
      <Field disabled>
        <Input />
      </Field>
    );
    const input = container.querySelector('input');
    expect(input?.getAttribute('disabled')).toBeDefined();
  });
});

describe('Fieldset', () => {
  it('should render a fieldset by default', () => {
    const { container } = render(<Fieldset>content</Fieldset>);
    expect(container.querySelector('fieldset')).not.toBeNull();
  });

  it('should render with custom as prop', () => {
    const { container } = render(<Fieldset as="div">content</Fieldset>);
    expect(container.querySelector('div')).not.toBeNull();
  });

  it('should cascade disabled to nested Field and Input', () => {
    render(
      <Fieldset disabled>
        <Field>
          <Input />
        </Field>
      </Fieldset>
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('should set disabled attribute on fieldset itself', () => {
    const { container } = render(<Fieldset disabled>content</Fieldset>);
    const fieldset = container.querySelector('fieldset');
    expect(fieldset?.getAttribute('disabled')).toBeDefined();
  });

  it('should cascade disabled even when Field has disabled=false', () => {
    render(
      <Fieldset disabled>
        <Field disabled={false}>
          <Input />
        </Field>
      </Fieldset>
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});

describe('Label', () => {
  it('should render a label by default', () => {
    const { container } = render(
      <Field>
        <Label>My Label</Label>
        <Input />
      </Field>
    );
    expect(container.querySelector('label')).not.toBeNull();
  });

  it('should render children', () => {
    render(
      <Field>
        <Label>Test Label</Label>
        <Input />
      </Field>
    );
    expect(screen.getByText('Test Label')).not.toBeNull();
  });

  it('should set htmlFor pointing to Input id', () => {
    const { container } = render(
      <Field>
        <Label>My Label</Label>
        <Input />
      </Field>
    );
    const label = container.querySelector('label');
    const input = container.querySelector('input');
    expect(label?.getAttribute('for')).toBe(input?.getAttribute('id'));
  });

  it('should set aria-labelledby on Input from Label id', () => {
    const { container } = render(
      <Field>
        <Label>My Label</Label>
        <Input />
      </Field>
    );
    const label = container.querySelector('label');
    const input = container.querySelector('input');
    expect(input?.getAttribute('aria-labelledby')).toBe(label?.getAttribute('id'));
  });

  it('should focus associated input when label is clicked', async () => {
    render(
      <Field>
        <Label>Click Me</Label>
        <Input />
      </Field>
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    const label = screen.getByText('Click Me');
    const focusSpy = vi.spyOn(input, 'focus');
    await act(async () => {
      fireEvent.click(label);
    });
    expect(focusSpy).toHaveBeenCalled();
  });

  it('should not focus input when passive Label is clicked', async () => {
    render(
      <Field>
        <Label passive>Passive Label</Label>
        <Input />
      </Field>
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    const label = screen.getByText('Passive Label');
    const focusSpy = vi.spyOn(input, 'focus');
    await act(async () => {
      fireEvent.click(label);
    });
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('should not set htmlFor on passive Label', () => {
    const { container } = render(
      <Field>
        <Label passive>Passive</Label>
        <Input />
      </Field>
    );
    const label = container.querySelector('label');
    expect(label?.getAttribute('for')).toBeNull();
  });

  it('should render without Field context (standalone label)', () => {
    render(<Label>Standalone</Label>);
    expect(screen.getByText('Standalone')).not.toBeNull();
  });

  it('should render with custom as prop', () => {
    const { container } = render(<Label as="span">My Label</Label>);
    expect(container.querySelector('span')).not.toBeNull();
  });
});

describe('Description', () => {
  it('should render a p by default', () => {
    const { container } = render(
      <Field>
        <Input />
        <Description>Help text</Description>
      </Field>
    );
    expect(container.querySelector('p')).not.toBeNull();
  });

  it('should render children', () => {
    render(
      <Field>
        <Description>Descriptive text</Description>
      </Field>
    );
    expect(screen.getByText('Descriptive text')).not.toBeNull();
  });

  it('should set aria-describedby on Input from Description id', () => {
    const { container } = render(
      <Field>
        <Input />
        <Description>Help text</Description>
      </Field>
    );
    const description = container.querySelector('p');
    const input = container.querySelector('input');
    expect(input?.getAttribute('aria-describedby')).toBe(description?.getAttribute('id'));
  });

  it('should render with custom as prop', () => {
    const { container } = render(<Description as="span">desc</Description>);
    expect(container.querySelector('span')).not.toBeNull();
  });

  it('should render without Field context (standalone)', () => {
    render(<Description>Standalone description</Description>);
    expect(screen.getByText('Standalone description')).not.toBeNull();
  });
});

describe('Input', () => {
  it('should render an input by default', () => {
    render(<Input />);
    expect(screen.getByRole('textbox')).not.toBeNull();
  });

  it('should render with custom as prop', () => {
    const { container } = render(<Input as="span" />);
    expect(container.querySelector('span')).not.toBeNull();
  });

  it('should be disabled when own disabled=true', () => {
    render(<Input disabled />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('should be disabled when Field is disabled', () => {
    render(
      <Field disabled>
        <Input />
      </Field>
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('should be disabled when Fieldset is disabled', () => {
    render(
      <Fieldset disabled>
        <Input />
      </Fieldset>
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('should set aria-invalid when invalid=true', () => {
    render(<Input invalid />);
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('should not set aria-invalid when invalid=false', () => {
    render(<Input />);
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('should set aria-labelledby from Field Label', () => {
    const { container } = render(
      <Field>
        <Label>Name</Label>
        <Input />
      </Field>
    );
    const label = container.querySelector('label');
    const input = container.querySelector('input');
    expect(input?.getAttribute('aria-labelledby')).toBe(label?.getAttribute('id'));
  });

  it('should set aria-describedby from Field Description', () => {
    const { container } = render(
      <Field>
        <Input />
        <Description>Hint</Description>
      </Field>
    );
    const desc = container.querySelector('p');
    const input = container.querySelector('input');
    expect(input?.getAttribute('aria-describedby')).toBe(desc?.getAttribute('id'));
  });

  it('should track hover state on mouseenter/mouseleave', async () => {
    render(<Input />);
    const input = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.mouseEnter(input);
    });
    await act(async () => {
      fireEvent.mouseLeave(input);
    });
    expect(input).not.toBeNull();
  });

  it('should track focus state on focus/blur', async () => {
    render(<Input />);
    const input = screen.getByRole('textbox');
    await act(async () => {
      input.focus();
    });
    await act(async () => {
      input.blur();
    });
    expect(input).not.toBeNull();
  });

  it('should set data-hover on mouseenter', async () => {
    render(<Input />);
    const input = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.mouseEnter(input);
    });
    expect(input.getAttribute('data-hover')).toBe('');
  });

  it('should clear data-hover on mouseleave', async () => {
    render(<Input />);
    const input = screen.getByRole('textbox');
    await act(async () => {
      fireEvent.mouseEnter(input);
    });
    expect(input.getAttribute('data-hover')).toBe('');
    await act(async () => {
      fireEvent.mouseLeave(input);
    });
    expect(input.getAttribute('data-hover')).toBeNull();
  });

  it('should set data-focus on focus', async () => {
    render(<Input />);
    const input = screen.getByRole('textbox');
    await act(async () => {
      input.focus();
    });
    expect(input.getAttribute('data-focus')).toBe('');
  });

  it('should clear data-focus on blur', async () => {
    render(<Input />);
    const input = screen.getByRole('textbox');
    await act(async () => {
      input.focus();
    });
    expect(input.getAttribute('data-focus')).toBe('');
    await act(async () => {
      input.blur();
    });
    expect(input.getAttribute('data-focus')).toBeNull();
  });

  it('should set data-disabled when disabled', () => {
    render(<Input disabled />);
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('data-disabled')).toBe('');
  });

  it('should not set data-disabled when not disabled', () => {
    render(<Input />);
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('data-disabled')).toBeNull();
  });

  it('should set data-invalid when invalid=true', () => {
    render(<Input invalid />);
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('data-invalid')).toBe('');
  });

  it('should not set data-invalid when invalid=false', () => {
    render(<Input />);
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('data-invalid')).toBeNull();
  });
});

describe('Textarea', () => {
  it('should render a textarea by default', () => {
    const { container } = render(<Textarea />);
    expect(container.querySelector('textarea')).not.toBeNull();
  });

  it('should be disabled when own disabled=true', () => {
    const { container } = render(<Textarea disabled />);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.disabled).toBe(true);
  });

  it('should be disabled when Field is disabled', () => {
    const { container } = render(
      <Field disabled>
        <Textarea />
      </Field>
    );
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.disabled).toBe(true);
  });

  it('should set aria-invalid when invalid=true', () => {
    const { container } = render(<Textarea invalid />);
    const ta = container.querySelector('textarea');
    expect(ta?.getAttribute('aria-invalid')).toBe('true');
  });

  it('should set aria-labelledby from Field Label', () => {
    const { container } = render(
      <Field>
        <Label>Bio</Label>
        <Textarea />
      </Field>
    );
    const label = container.querySelector('label');
    const ta = container.querySelector('textarea');
    expect(ta?.getAttribute('aria-labelledby')).toBe(label?.getAttribute('id'));
  });

  it('should set aria-describedby from Field Description', () => {
    const { container } = render(
      <Field>
        <Textarea />
        <Description>Max 200 chars</Description>
      </Field>
    );
    const desc = container.querySelector('p');
    const ta = container.querySelector('textarea');
    expect(ta?.getAttribute('aria-describedby')).toBe(desc?.getAttribute('id'));
  });

  it('should track hover/focus state without error', async () => {
    const { container } = render(<Textarea />);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.mouseEnter(ta);
    });
    await act(async () => {
      fireEvent.mouseLeave(ta);
    });
    await act(async () => {
      ta.focus();
    });
    await act(async () => {
      ta.blur();
    });
    expect(ta).not.toBeNull();
  });
});

describe('Select', () => {
  it('should render a select by default', () => {
    const { container } = render(
      <Select>
        <option value="a">A</option>
      </Select>
    );
    expect(container.querySelector('select')).not.toBeNull();
  });

  it('should be disabled when own disabled=true', () => {
    const { container } = render(
      <Select disabled>
        <option>A</option>
      </Select>
    );
    const sel = container.querySelector('select') as HTMLSelectElement;
    expect(sel.disabled).toBe(true);
  });

  it('should be disabled when Field is disabled', () => {
    const { container } = render(
      <Field disabled>
        <Select>
          <option>A</option>
        </Select>
      </Field>
    );
    const sel = container.querySelector('select') as HTMLSelectElement;
    expect(sel.disabled).toBe(true);
  });

  it('should set aria-invalid when invalid=true', () => {
    const { container } = render(
      <Select invalid>
        <option>A</option>
      </Select>
    );
    const sel = container.querySelector('select');
    expect(sel?.getAttribute('aria-invalid')).toBe('true');
  });

  it('should set aria-labelledby from Field Label', () => {
    const { container } = render(
      <Field>
        <Label>Size</Label>
        <Select>
          <option value="s">S</option>
        </Select>
      </Field>
    );
    const label = container.querySelector('label');
    const sel = container.querySelector('select');
    expect(sel?.getAttribute('aria-labelledby')).toBe(label?.getAttribute('id'));
  });

  it('should set aria-describedby from Field Description', () => {
    const { container } = render(
      <Field>
        <Select>
          <option>A</option>
        </Select>
        <Description>Pick a size</Description>
      </Field>
    );
    const desc = container.querySelector('p');
    const sel = container.querySelector('select');
    expect(sel?.getAttribute('aria-describedby')).toBe(desc?.getAttribute('id'));
  });

  it('should track hover/focus state without error', async () => {
    const { container } = render(
      <Select>
        <option>A</option>
      </Select>
    );
    const sel = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      fireEvent.mouseEnter(sel);
    });
    await act(async () => {
      fireEvent.mouseLeave(sel);
    });
    await act(async () => {
      sel.focus();
    });
    await act(async () => {
      sel.blur();
    });
    expect(sel).not.toBeNull();
  });
});

describe('Legend', () => {
  it('should render a legend by default', () => {
    const { container } = render(
      <Fieldset>
        <Legend>Group title</Legend>
      </Fieldset>
    );
    expect(container.querySelector('legend')).not.toBeNull();
  });

  it('should render children', () => {
    render(
      <Fieldset>
        <Legend>My Legend</Legend>
      </Fieldset>
    );
    expect(screen.getByText('My Legend')).not.toBeNull();
  });

  it('should render with custom as prop', () => {
    const { container } = render(<Legend as="span">Legend</Legend>);
    expect(container.querySelector('span')).not.toBeNull();
  });
});

describe('Field + Fieldset combined', () => {
  it('should provide both aria-labelledby and aria-describedby to Input', () => {
    const { container } = render(
      <Field>
        <Label>Username</Label>
        <Input />
        <Description>Must be unique</Description>
      </Field>
    );
    const label = container.querySelector('label');
    const desc = container.querySelector('p');
    const input = container.querySelector('input');
    expect(input?.getAttribute('aria-labelledby')).toBe(label?.getAttribute('id'));
    expect(input?.getAttribute('aria-describedby')).toBe(desc?.getAttribute('id'));
  });

  it('Field own disabled overrides inherited (Field.disabled=true wins)', () => {
    render(
      <Fieldset disabled={false}>
        <Field disabled>
          <Input />
        </Field>
      </Fieldset>
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('Fieldset disabled wins over Field disabled=false', () => {
    render(
      <Fieldset disabled>
        <Field disabled={false}>
          <Input />
        </Field>
      </Fieldset>
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('Label without controlId does not crash on click', async () => {
    render(
      <Field>
        <Label>No control</Label>
      </Field>
    );
    const label = screen.getByText('No control');
    await act(async () => {
      fireEvent.click(label);
    });
    expect(label).not.toBeNull();
  });
});

describe('FieldError', () => {
  it('should render a p by default', () => {
    const { container } = render(
      <Field>
        <Input />
        <FieldError>Error message</FieldError>
      </Field>
    );
    expect(container.querySelector('p')).not.toBeNull();
  });

  it('should render children', () => {
    render(
      <Field>
        <FieldError>Error text</FieldError>
      </Field>
    );
    expect(screen.getByText('Error text')).not.toBeNull();
  });

  it('should set role=alert', () => {
    const { container } = render(
      <Field>
        <Input />
        <FieldError>Error</FieldError>
      </Field>
    );
    const error = container.querySelector('p');
    expect(error?.getAttribute('role')).toBe('alert');
  });

  it('should set aria-describedby on Input from FieldError id', () => {
    const { container } = render(
      <Field>
        <Input />
        <FieldError>Error message</FieldError>
      </Field>
    );
    const error = container.querySelector('p');
    const input = container.querySelector('input');
    expect(input?.getAttribute('aria-describedby')).toBe(error?.getAttribute('id'));
  });

  it('should set aria-invalid on Input when FieldError is present', () => {
    render(
      <Field>
        <Input />
        <FieldError>Error</FieldError>
      </Field>
    );
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('should not set aria-invalid when no FieldError', () => {
    render(
      <Field>
        <Input />
      </Field>
    );
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('should clear aria-invalid when FieldError is unmounted', () => {
    const { rerender } = render(
      <Field>
        <Input />
        <FieldError>Error</FieldError>
      </Field>
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');

    rerender(
      <Field>
        <Input />
      </Field>
    );
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('should render with custom as prop', () => {
    const { container } = render(
      <Field>
        <FieldError as="span">Error</FieldError>
      </Field>
    );
    const error = container.querySelector('span');
    expect(error?.getAttribute('role')).toBe('alert');
  });

  it('should render without Field context (standalone)', () => {
    render(<FieldError>Standalone error</FieldError>);
    expect(screen.getByText('Standalone error')).not.toBeNull();
  });

  it('should work with Textarea', () => {
    render(
      <Field>
        <Textarea />
        <FieldError>Textarea error</FieldError>
      </Field>
    );
    const ta = screen.getByRole('textbox');
    expect(ta.getAttribute('aria-invalid')).toBe('true');
  });

  it('should work with Select', () => {
    render(
      <Field>
        <Select>
          <option>A</option>
        </Select>
        <FieldError>Select error</FieldError>
      </Field>
    );
    const sel = screen.getByRole('combobox');
    expect(sel.getAttribute('aria-invalid')).toBe('true');
  });

  it('should set data-invalid on Input when FieldError is present', () => {
    render(
      <Field>
        <Input />
        <FieldError>Error</FieldError>
      </Field>
    );
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('data-invalid')).toBe('');
  });

  it('should work with both Description and FieldError (no clobbering)', () => {
    const { container } = render(
      <Field>
        <Label>Name</Label>
        <Input />
        <Description>Help text</Description>
        <FieldError>Error text</FieldError>
      </Field>
    );
    const input = container.querySelector('input');
    const desc = container.querySelector('p[id]');
    const error = container.querySelector('p[role="alert"]');

    const describedBy = input?.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(describedBy).toContain(desc?.getAttribute('id'));
    expect(describedBy).toContain(error?.getAttribute('id'));
  });

  it('should keep aria-describedby working after one FieldError unmounts (counter pattern)', () => {
    const { rerender } = render(
      <Field>
        <Input />
        <FieldError>Error 1</FieldError>
        <FieldError>Error 2</FieldError>
      </Field>
    );
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    rerender(
      <Field>
        <Input />
        <FieldError>Error 1</FieldError>
      </Field>
    );
    expect(input.getAttribute('aria-invalid')).toBe('true');

    rerender(
      <Field>
        <Input />
      </Field>
    );
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('should keep aria-describedby working after Description unmounts (no clobbering)', () => {
    const { rerender } = render(
      <Field>
        <Input />
        <Description>Help text</Description>
        <FieldError>Error text</FieldError>
      </Field>
    );
    const input = screen.getByRole('textbox');
    const error = document.querySelector('p[role="alert"]');
    const describedBy = input.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(describedBy).toContain(error?.getAttribute('id'));

    rerender(
      <Field>
        <Input />
        <FieldError>Error text</FieldError>
      </Field>
    );
    const describedByAfter = input.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(describedByAfter).toContain(error?.getAttribute('id'));
  });
});
