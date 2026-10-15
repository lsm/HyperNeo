import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import { NeoProjectTree } from '../NeoProjectTree.tsx';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request: api.request }) },
}));
const project = (id: string, parentId: string | null = null): NeoProject => ({
  id,
  title: id,
  parentId,
  summary: '',
  context: '',
  revision: 3,
  createdAt: 0,
  updatedAt: 0,
});
beforeEach(() => {
  vi.clearAllMocks();
  api.request.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe('Neo project hierarchy controls', () => {
  it('shows nested paths and moves with the current revision, excluding descendants', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(
      <NeoProjectTree
        projects={[project('Product'), project('Repo', 'Product'), project('Section', 'Repo')]}
        refresh={refresh}
      />
    );
    expect(screen.getByLabelText('Path for Section').textContent).toBe('Product › Repo › Section');
    const root = screen.getByLabelText('Move Product under') as HTMLSelectElement;
    expect([...root.options].map((option) => option.value)).toEqual(['']);
    fireEvent.change(screen.getByLabelText('Move Section under'), { target: { value: 'Product' } });
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('operation.invoke', {
        name: 'neo.project.move',
        input: { id: 'Section', parentId: 'Product', expectedRevision: 3 },
      })
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
  it('shows a failed move without pretending the snapshot changed', async () => {
    api.request.mockResolvedValue({ ok: false, reason: 'superseded' });
    const refresh = vi.fn();
    render(
      <NeoProjectTree projects={[project('Root'), project('Child', 'Root')]} refresh={refresh} />
    );
    fireEvent.change(screen.getByLabelText('Move Child under'), { target: { value: '' } });
    expect((await screen.findByRole('alert')).textContent).toBe('superseded');
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Path for Child').textContent).toBe('Root › Child');
  });
  it('creates a section only after an explicit epic submission', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<NeoProjectTree projects={[project('Repo')]} refresh={refresh} />);
    expect(api.request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Parent project'), { target: { value: 'Repo' } });
    fireEvent.input(screen.getByLabelText('GitHub epic URL'), {
      target: { value: 'https://github.com/lsm/HyperNeo/issues/6756' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add section' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('operation.invoke', {
        name: 'neo.project.section',
        input: { parentId: 'Repo', epicUrl: 'https://github.com/lsm/HyperNeo/issues/6756' },
      })
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
});
