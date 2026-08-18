import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadBundle } from '../export-import-utils.ts';
import type { SpaceExportBundle } from '@hyperneo/shared';

const makeBundle = (overrides: Partial<SpaceExportBundle> = {}): SpaceExportBundle => ({
  version: 2,
  type: 'bundle',
  name: 'Test Bundle',
  agents: [],
  workflows: [],
  exportedAt: 1000,
  ...overrides,
});

describe('downloadBundle', () => {
  let appendChildSpy: ReturnType<typeof vi.spyOn>;
  let removeChildSpy: ReturnType<typeof vi.spyOn>;
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let clickSpy: () => void;
  let createdAnchor: HTMLAnchorElement | null = null;

  beforeEach(() => {
    clickSpy = vi.fn() as unknown as () => void;
    createObjectURLSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:http://localhost/test');
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);

    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        createdAnchor = el as HTMLAnchorElement;
        (el as HTMLAnchorElement).click = clickSpy;
      }
      return el;
    });

    appendChildSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((node) => node);
    removeChildSpy = vi.spyOn(document.body, 'removeChild').mockImplementation((node) => node);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    createdAnchor = null;
  });

  it('triggers a download with a .hyperneo.json filename', () => {
    const bundle = makeBundle({ name: 'My Bundle' });
    downloadBundle(bundle, 'My Space', 'bundle');

    expect(clickSpy as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    expect(createObjectURLSpy).toHaveBeenCalledOnce();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/test');
    expect(createdAnchor?.download).toMatch(/\.hyperneo\.json$/);
    expect(createdAnchor?.download).toContain('bundle');
  });

  it('sanitizes the space name in the filename', () => {
    const bundle = makeBundle();
    downloadBundle(bundle, 'My Fancy Space!', 'agents');

    expect(createdAnchor?.download).toMatch(
      /^my-fancy-space--agents-\d{4}-\d{2}-\d{2}\.hyperneo\.json$/
    );
  });

  it('includes type in the filename', () => {
    downloadBundle(makeBundle(), 'space', 'workflows');
    expect(createdAnchor?.download).toContain('workflows');
  });

  it('appends and removes anchor from body', () => {
    downloadBundle(makeBundle(), 'space', 'bundle');
    expect(appendChildSpy).toHaveBeenCalled();
    expect(removeChildSpy).toHaveBeenCalled();
  });

  it('creates a valid JSON blob', () => {
    const bundle = makeBundle({
      name: 'Test',
      agents: [{ version: 2, type: 'agent', name: 'A', tools: [] }],
      workflows: [],
    });
    downloadBundle(bundle, 'space', 'agents');

    const blobCall = createObjectURLSpy.mock.calls[0][0] as Blob;
    expect(blobCall).toBeInstanceOf(Blob);
    expect(blobCall.type).toBe('application/json');
  });
});
