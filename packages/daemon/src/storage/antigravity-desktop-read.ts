import { statSync } from 'node:fs';
import { normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  AntigravityDesktopRead,
  AntigravityDesktopSession,
} from '../lib/drivers/antigravity-desktop-discovery.ts';
import { Database } from './sqlite-compat.ts';

type Catalog = { ids: string[]; sessions: AntigravityDesktopSession[] };
type Row = Omit<AntigravityDesktopSession, 'folder'> & { workspaceUris: string };
const desktopRows = `FROM conversation_summaries
  WHERE source = '' AND app_data_dir = 'antigravity'
    AND typeof(conversation_id) = 'text' AND conversation_id <> ''`;

function localFolders(workspaceUris: string): string[] | null {
  if (!workspaceUris.trim()) return [];
  let uris: unknown;
  try {
    uris = JSON.parse(workspaceUris);
  } catch {
    return null;
  }
  if (!Array.isArray(uris)) return null;
  const folders = uris.flatMap((entry: unknown) => {
    if (typeof entry !== 'string') return [];
    try {
      const uri = new URL(entry);
      if (uri.hostname || uri.protocol !== 'file:') return [];
      return [normalize(fileURLToPath(uri))];
    } catch {
      return [];
    }
  });
  return folders.length > 0 || uris.length === 0 ? folders : null;
}

function readCatalog({ statePath, query }: AntigravityDesktopRead, readonlyUri = false): Catalog {
  const db = new Database(statePath, { readonly: true, readonlyUri });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=500');
    if (!query) {
      const rows = db.prepare<{ id: string }>(`SELECT conversation_id AS id ${desktopRows}`).all();
      return { ids: rows.map(({ id }) => id), sessions: [] };
    }
    const text = query.text?.toLowerCase();
    const key = (folder: string) => (process.platform === 'win32' ? folder.toLowerCase() : folder);
    const requested = query.folder ? key(normalize(query.folder)) : undefined;
    const sessions: AntigravityDesktopSession[] = [];
    const rows = db
      .prepare<Row>(`
      SELECT conversation_id AS id, COALESCE(NULLIF(trim(title), ''), 'Untitled Antigravity session') AS title,
        workspace_uris AS workspaceUris, COALESCE(unixepoch(last_modified_time), 0) * 1000 AS updatedAt
        ${desktopRows}
        AND parent_conversation_id = '' AND nesting_depth = 0
        AND conversation_id = COALESCE(?, conversation_id) AND instr(conversation_id, ?) = 1
      ORDER BY updatedAt DESC, id
    `)
      .iterate(query.id ?? null, query.idPrefix ?? '');
    for (const { workspaceUris, ...session } of rows) {
      if (sessions.length >= query.limit) break;
      const folders = localFolders(workspaceUris);
      if (!folders) continue;
      const folder = requested ? folders.find((value) => key(value) === requested) : folders[0];
      if (requested && !folder) continue;
      if (
        text &&
        !session.title.toLowerCase().includes(text) &&
        !folders.some((value) => value.toLowerCase().includes(text))
      )
        continue;
      sessions.push({ ...session, folder });
    }
    return { ids: [], sessions };
  } finally {
    db.close();
  }
}

export function readAntigravityDesktop(input: AntigravityDesktopRead): Catalog {
  try {
    return readCatalog(input);
  } catch (error) {
    if (
      !/unable to open database file|readonly database/.test(String(error)) ||
      (statSync(`${input.statePath}-wal`, { throwIfNoEntry: false })?.size ?? 0) > 0
    )
      throw error;
    const url = pathToFileURL(input.statePath);
    url.searchParams.set('immutable', '1');
    return readCatalog({ ...input, statePath: url.href }, true);
  }
}
