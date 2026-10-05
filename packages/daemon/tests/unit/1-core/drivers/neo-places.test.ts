import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { foldNeoPlaces, foldNeoSessions } from '../../../../src/lib/drivers/hyperneo-adapter';

const root = join('/data', 'Neo');

describe('foldNeoPlaces', () => {
  test('folds Neo task folders into the one Neo place and keeps other folders', () => {
    expect(
      foldNeoPlaces(
        [
          {
            folder: join(root, 'research-a-1'),
            openCount: 1,
            archivedCount: 0,
            known: 0,
            lastActiveAt: '2026-10-05T10:00:00Z',
          },
          {
            folder: join(root, 'research-b-2'),
            openCount: 2,
            archivedCount: 1,
            known: 0,
            lastActiveAt: '2026-10-05T12:00:00Z',
          },
          { folder: root, openCount: 0, archivedCount: 0, known: 1, lastActiveAt: null },
          {
            folder: '/focus/dolmen',
            openCount: 3,
            archivedCount: 0,
            known: 1,
            lastActiveAt: '2026-10-05T09:00:00Z',
          },
          {
            folder: `${root}-elsewhere`,
            openCount: 1,
            archivedCount: 0,
            known: 0,
            lastActiveAt: null,
          },
        ],
        root
      )
    ).toEqual([
      {
        folder: root,
        openCount: 3,
        archivedCount: 1,
        known: 1,
        lastActiveAt: '2026-10-05T12:00:00Z',
      },
      {
        folder: '/focus/dolmen',
        openCount: 3,
        archivedCount: 0,
        known: 1,
        lastActiveAt: '2026-10-05T09:00:00Z',
      },
      { folder: `${root}-elsewhere`, openCount: 1, archivedCount: 0, known: 0, lastActiveAt: null },
    ]);
  });
});

describe('foldNeoSessions', () => {
  test('lists a session in a Neo task folder under the Neo place', () => {
    const session = { id: 's', title: 't', status: 'active', processing: null, lastActiveAt: null };
    expect(
      foldNeoSessions(
        [
          { ...session, folder: join(root, 'research-a-1') },
          { ...session, id: 'd', folder: '/focus/dolmen' },
        ],
        root
      ).map((row) => row.folder)
    ).toEqual([root, '/focus/dolmen']);
  });
});
