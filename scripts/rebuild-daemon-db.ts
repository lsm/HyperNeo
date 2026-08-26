#!/usr/bin/env bun

import { Database } from 'bun:sqlite';
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { getDataDir } from '../packages/daemon/src/lib/data-dir.ts';

const DEFAULT_DB_PATH = join(getDataDir(), 'data', 'daemon.db');
const MIN_FREE_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024;
const COPY_BATCH_ROWS = 50_000;
const SRC_SCHEMA = 'src';

type Options = {
  dbPath: string;
  yes: boolean;
  force: boolean;
  noSwap: boolean;
  fullIntegrity: boolean;
};

type MasterRow = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};

type ColumnRow = {
  name: string;
  type: string;
  pk: number;
  hidden: number;
};

type ForeignKeyRow = {
  id: number;
  seq: number;
  table: string;
};

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    dbPath: process.env.DB_PATH || DEFAULT_DB_PATH,
    yes: false,
    force: false,
    noSwap: false,
    fullIntegrity: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db-path') {
      const value = argv[++i];
      if (!value) throw new Error('--db-path requires a value');
      options.dbPath = value;
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--no-swap') {
      options.noSwap = true;
    } else if (arg === '--full-integrity') {
      options.fullIntegrity = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.dbPath = resolve(options.dbPath);
  return options;
}

function printHelp(): void {
  console.log(`Usage: bun run scripts/rebuild-daemon-db.ts [options]

Rebuilds the daemon database into a fresh file (auto_vacuum=INCREMENTAL, WAL), copies
every row of every table, verifies counts/schema/integrity, then swaps it in. The
original file is renamed to <db>.pre-rebuild-<timestamp> and kept as the backup;
the script never deletes it.

Options:
  --db-path <path>   Database path (default: ${DEFAULT_DB_PATH})
  -y, --yes          Run without confirmation prompt
  --no-swap          Build and verify only; leave the new file next to the original.
                     The snapshot goes stale the moment anything writes to the
                     original, so keep the daemon stopped and swap at once, or
                     discard the new file and re-run.
  --full-integrity   Run PRAGMA integrity_check instead of quick_check
  --force            Ignore a live daemon lock (not recommended)
  -h, --help         Show this help
`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

let heldLockPath: string | null = null;

const releaseLockOnExit = () => {
  if (heldLockPath === null) return;
  try {
    unlinkSync(heldLockPath);
  } catch {}
};

let stagingNonce = 0;

function claimExclusivePath(stagingPath: string, targetPath: string): boolean {
  const nonce = `${Date.now()}-${process.pid}-${(stagingNonce++).toString(36)}-${Math.floor(
    Math.random() * 2 ** 48
  ).toString(36)}`;
  const staged = `${stagingPath}.${nonce}`;
  try {
    writeFileSync(staged, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      rmSync(staged, { force: true });
      return claimExclusivePath(stagingPath, targetPath);
    }
    throw error;
  }
  try {
    try {
      linkSync(staged, targetPath);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
          try {
            writeFileSync(targetPath, String(process.pid), { flag: 'wx' });
            return true;
          } catch (writeError) {
            if ((writeError as NodeJS.ErrnoException).code === 'EEXIST') return false;
            throw writeError;
          }
        }
        throw error;
      }
      return false;
    }
  } finally {
    rmSync(staged, { force: true });
  }
}

function takeoverMarkerPath(lockPath: string): string {
  return `${lockPath}.takeover`;
}

const EMPTY_LOCK_GRACE_MS = 10_000;

function isEmptyLockAbandoned(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs >= EMPTY_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

function takeoverInProgress(lockPath: string): boolean {
  return existsSync(takeoverMarkerPath(lockPath));
}

export function acquireDatabaseLock(dbPath: string): boolean {
  const lockPath = `${dbPath}.lock`;
  const stagingPath = `${lockPath}.${process.pid}.staging`;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (claimExclusivePath(stagingPath, lockPath)) {
      if (takeoverInProgress(lockPath)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      heldLockPath = lockPath;
      process.on('exit', releaseLockOnExit);
      return true;
    }
    let raw = '';
    try {
      raw = readFileSync(lockPath, 'utf-8').trim();
    } catch {
      continue;
    }
    if (raw === '') {
      if (!isEmptyLockAbandoned(lockPath)) continue;
      console.warn('Removing an abandoned empty daemon lock');
    }
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid !== process.pid && isProcessAlive(pid)) return false;
    if (Number.isFinite(pid)) {
      console.warn(`Removing stale daemon lock from PID ${pid}`);
    }
    if (takeoverInProgress(lockPath)) continue;
    if (!claimExclusivePath(`${lockPath}.${process.pid}.staging`, takeoverMarkerPath(lockPath))) {
      continue;
    }
    let becameOwner = false;
    try {
      let current = Number.NaN;
      try {
        current = Number.parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
      } catch {}
      if (Number.isFinite(current) && current !== process.pid && isProcessAlive(current)) continue;
      try {
        unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      becameOwner = claimExclusivePath(stagingPath, lockPath);
    } finally {
      try {
        unlinkSync(takeoverMarkerPath(lockPath));
      } catch {}
    }
    if (becameOwner) {
      heldLockPath = lockPath;
      process.on('exit', releaseLockOnExit);
      return true;
    }
  }
  return false;
}

export function staleTakeoverHint(dbPath: string): string {
  const lockPath = `${dbPath}.lock`;
  const marker = takeoverMarkerPath(lockPath);
  if (existsSync(marker)) {
    return (
      `\nA takeover marker exists at ${marker}; if no rebuild or daemon is currently` +
      ` reclaiming the stale lock, verify and remove it, then retry.`
    );
  }
  try {
    if (readFileSync(lockPath, 'utf-8').trim() === '') {
      return (
        `\n${lockPath} exists but is empty (likely an interrupted creation on a filesystem` +
        ` without hard links); verify no daemon is running and remove the file, then retry.`
      );
    }
  } catch {}
  return '';
}

export function releaseDatabaseLock(): void {
  if (heldLockPath === null) return;
  process.removeListener('exit', releaseLockOnExit);
  try {
    unlinkSync(heldLockPath);
  } catch {}
  heldLockPath = null;
}

export function liveLockHolderPid(lockPath: string): number | null {
  if (!existsSync(lockPath)) return null;
  const raw = readFileSync(lockPath, 'utf-8').trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid === process.pid || !isProcessAlive(pid)) return null;
  return pid;
}

const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP']);

function isLinkUnsupportedError(error: unknown): boolean {
  return LINK_UNSUPPORTED_CODES.has((error as NodeJS.ErrnoException).code ?? '');
}

function hardLinksSupported(dir: string): boolean {
  const nonce = `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 2 ** 48).toString(36)}`;
  const probeA = join(dir, `.rebuild-hl-probe-${nonce}.a`);
  const probeB = join(dir, `.rebuild-hl-probe-${nonce}.b`);
  try {
    writeFileSync(probeA, 'x', { flag: 'wx' });
    try {
      linkSync(probeA, probeB);
      return true;
    } catch (error) {
      if (isLinkUnsupportedError(error)) return false;
      throw error;
    } finally {
      rmSync(probeA, { force: true });
      rmSync(probeB, { force: true });
    }
  } catch {
    rmSync(probeA, { force: true });
    rmSync(probeB, { force: true });
    return true;
  }
}

function preserveOriginal(dbPath: string, backupPath: string): void {
  try {
    linkSync(dbPath, backupPath);
  } catch (error) {
    if (!isLinkUnsupportedError(error)) throw error;
    copyFileSync(dbPath, backupPath);
    applyOriginalMetadata(dbPath, backupPath);
  }
}

function applyOriginalMetadata(originalPath: string, targetPath: string): void {
  const stats = statSync(originalPath);
  try {
    chmodSync(targetPath, stats.mode & 0o777);
  } catch (error) {
    throw new Error(`Could not restore file permissions on ${targetPath}: ${String(error)}`);
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
  const currentGid = typeof process.getgid === 'function' ? process.getgid() : stats.gid;
  if (stats.uid === currentUid && stats.gid === currentGid) return;
  try {
    chownSync(targetPath, stats.uid, stats.gid);
  } catch (error) {
    throw new Error(
      `Could not restore ownership of ${targetPath} to ${stats.uid}:${stats.gid};` +
        ` run the rebuild as the database owner or root: ${String(error)}`
    );
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readSchema(db: Database, schema: string): MasterRow[] {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM ${quoteIdent(schema)}.sqlite_master` +
        ` WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid`
    )
    .all() as MasterRow[];
}

function tableExists(db: Database, schema: string, name: string): boolean {
  const row = db
    .prepare(
      `SELECT name FROM ${quoteIdent(schema)}.sqlite_master WHERE type = 'table' AND name = ?`
    )
    .get(name) as { name?: string } | undefined;
  return !!row?.name;
}

function isVirtualTable(row: MasterRow): boolean {
  return (row.sql ?? '').trimStart().toUpperCase().startsWith('CREATE VIRTUAL TABLE');
}

type ClassifiedSchema = {
  plainTables: MasterRow[];
  virtualTables: MasterRow[];
  otherObjects: MasterRow[];
};

const FTS5_INTERNAL_SHADOW_SUFFIXES = new Set(['_data', '_idx', '_content', '_docsize', '_config']);
const FTS5_EXTERNAL_SHADOW_SUFFIXES = new Set(['_data', '_idx', '_config', '_docsize']);

type FtsMode = 'external' | 'internal';

function splitTopLevelArgs(args: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let bracketDepth = 0;
  let inBlockComment = false;
  let inLineComment = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    const next = args[i + 1];
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += '/';
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (bracketDepth > 0) {
      current += ch;
      if (ch === ']') bracketDepth--;
      continue;
    }
    if (ch === '/' && next === '*') {
      current += '/*';
      i++;
      inBlockComment = true;
      continue;
    }
    if (ch === '-' && next === '-') {
      current += '--';
      i++;
      inLineComment = true;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') {
      bracketDepth = 1;
      current += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((part) => part.trim());
}

function stripTopLevelComments(sql: string): string {
  let out = '';
  let quote: string | null = null;
  let bracketDepth = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (bracketDepth > 0) {
      out += ch;
      if (ch === ']') bracketDepth--;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '[') {
      bracketDepth = 1;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function findFtsArgOpen(sql: string): number {
  let i = 0;
  let quote: string | null = null;
  let bracketDepth = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (bracketDepth > 0) {
      if (ch === ']') bracketDepth--;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '[') {
      bracketDepth = 1;
      i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '(') return i;
    i++;
  }
  return -1;
}

function stripOptionQuotes(raw: string): string {
  const stripped = stripTopLevelComments(raw).trim();
  if (
    (stripped.startsWith("'") && stripped.endsWith("'") && stripped.length >= 2) ||
    (stripped.startsWith('"') && stripped.endsWith('"') && stripped.length >= 2) ||
    (stripped.startsWith('`') && stripped.endsWith('`') && stripped.length >= 2)
  ) {
    return stripped.slice(1, -1);
  }
  if (stripped.startsWith('[') && stripped.endsWith(']')) return stripped.slice(1, -1);
  return stripped;
}

export function ftsTopLevelOptions(sql: string): Map<string, string> {
  const options = new Map<string, string>();
  const open = findFtsArgOpen(sql);
  const close = sql.lastIndexOf(')');
  if (open === -1 || close <= open) return options;
  for (const part of splitTopLevelArgs(sql.slice(open + 1, close))) {
    const cleaned = stripTopLevelComments(part).trim();
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/i.exec(cleaned);
    if (match === null) continue;
    options.set(match[1].toLowerCase(), stripOptionQuotes(match[2].trim()));
  }
  return options;
}

export function ftsContentOption(sql: string): string | null {
  const content = ftsTopLevelOptions(sql).get('content');
  return content === undefined ? null : content;
}

function ftsModes(virtualTables: MasterRow[]): Map<string, FtsMode> {
  const modes = new Map<string, FtsMode>();
  for (const row of virtualTables) {
    const sql = row.sql ?? '';
    const content = ftsContentOption(sql);
    if (content === '') {
      throw new Error(
        `Contentless FTS5 table ${row.name} is not supported by this rebuild;` +
          ` export it manually before rebuilding the database`
      );
    }
    if (ftsTopLevelOptions(sql).get('locale')?.trim() === '1') {
      throw new Error(
        `FTS5 table ${row.name} enables per-row locales (locale=1), which a content copy` +
          ` cannot preserve; export it manually before rebuilding the database`
      );
    }
    modes.set(row.name, content !== null ? 'external' : 'internal');
  }
  return modes;
}

function ftsShadowSuffixes(mode: FtsMode, options: Map<string, string>): Set<string> {
  const base = mode === 'internal' ? FTS5_INTERNAL_SHADOW_SUFFIXES : FTS5_EXTERNAL_SHADOW_SUFFIXES;
  if (options.get('columnsize')?.trim() === '0') {
    const trimmed = new Set(base);
    trimmed.delete('_docsize');
    return trimmed;
  }
  return base;
}

function ftsShadowOwner(
  name: string,
  virtualNames: string[],
  modes: Map<string, FtsMode>,
  optionsByName: Map<string, Map<string, string>>
): string | null {
  for (const v of virtualNames) {
    if (!name.startsWith(`${v}_`)) continue;
    const suffix = name.slice(v.length);
    const mode = modes.get(v);
    if (mode === undefined) continue;
    const suffixes = ftsShadowSuffixes(mode, optionsByName.get(v) ?? new Map());
    if (suffixes.has(suffix)) return v;
  }
  return null;
}

function virtualNamesOf(virtualTables: MasterRow[]): string[] {
  return virtualTables.map((row) => row.name);
}

function classifySchema(
  rows: MasterRow[],
  modes: Map<string, FtsMode>,
  optionsByName: Map<string, Map<string, string>>
): ClassifiedSchema {
  const virtualTables = rows.filter((row) => row.type === 'table' && isVirtualTable(row));
  const virtualNames = virtualTables.map((row) => row.name);
  const plainTables = rows.filter(
    (row) =>
      row.type === 'table' &&
      !isVirtualTable(row) &&
      ftsShadowOwner(row.name, virtualNames, modes, optionsByName) === null
  );
  const otherObjects = rows.filter(
    (row) =>
      row.type !== 'table' &&
      row.sql !== null &&
      ftsShadowOwner(row.tbl_name, virtualNames, modes, optionsByName) === null
  );
  return { plainTables, virtualTables, otherObjects };
}

function dependencyOrder(tables: MasterRow[], deps: Map<string, Set<string>>): MasterRow[] {
  const remaining = new Set(tables.map((row) => row.name));
  const ordered: MasterRow[] = [];
  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;
    for (const row of tables) {
      if (!remaining.has(row.name)) continue;
      const blocking = [...(deps.get(row.name) ?? [])].filter(
        (dep) => dep !== row.name && remaining.has(dep)
      );
      if (blocking.length > 0) continue;
      ordered.push(row);
      remaining.delete(row.name);
      progressed = true;
    }
  }
  ordered.push(...tables.filter((row) => remaining.has(row.name)));
  return ordered;
}

function foreignKeyDependencies(db: Database, tables: MasterRow[]): Map<string, Set<string>> {
  const names = new Set(tables.map((row) => row.name));
  const deps = new Map<string, Set<string>>();
  for (const row of tables) {
    const rows = db
      .prepare(`PRAGMA ${quoteIdent(SRC_SCHEMA)}.foreign_key_list(${quoteString(row.name)})`)
      .all() as ForeignKeyRow[];
    deps.set(
      row.name,
      new Set(rows.map((fk) => fk.table).filter((table) => names.has(table) && table !== row.name))
    );
  }
  return deps;
}

function assertFts5(virtualTables: MasterRow[]): void {
  for (const row of virtualTables) {
    const cleaned = stripTopLevelComments(row.sql ?? '');
    if (!/USING\s+(?:'fts5'|"fts5"|`fts5`|\[fts5\]|fts5)(?=\s|\()/i.test(cleaned)) {
      throw new Error(
        `Unsupported virtual table module for rebuild: ${row.name} (${row.sql ?? 'no sql'})`
      );
    }
  }
}

function unshadowedRowidName(db: Database, schema: string, table: string): string | null {
  const shadowed = new Set(
    tableColumns(db, schema, table).map((column) => column.name.toLowerCase())
  );
  for (const candidate of ['rowid', '_rowid_', 'oid']) {
    if (shadowed.has(candidate)) continue;
    try {
      db.prepare(`SELECT ${candidate} FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT 0`);
      return candidate;
    } catch {}
  }
  return null;
}

function tableColumns(db: Database, schema: string, table: string): ColumnRow[] {
  return db
    .prepare(`PRAGMA ${quoteIdent(schema)}.table_xinfo(${quoteString(table)})`)
    .all() as ColumnRow[];
}

function copyTableData(db: Database, table: string): number {
  const allColumns = tableColumns(db, SRC_SCHEMA, table);
  const columns = allColumns.filter((column) => column.hidden === 0);
  const srcRowid = unshadowedRowidName(db, SRC_SCHEMA, table);
  const dstRowid = srcRowid === null ? null : unshadowedRowidName(db, 'main', table);
  const userColumns = columns.map((column) => quoteIdent(column.name));
  const insertColumns =
    srcRowid !== null && dstRowid !== null ? [quoteIdent(dstRowid), ...userColumns] : userColumns;
  const selectColumns =
    srcRowid !== null && dstRowid !== null ? [quoteIdent(srcRowid), ...userColumns] : userColumns;
  const insertTargets = insertColumns.join(', ');
  const selectTargets = selectColumns.join(', ');
  const cursorColumn = srcRowid !== null && dstRowid !== null ? srcRowid : null;
  const sourceTable = `${quoteIdent(SRC_SCHEMA)}.${quoteIdent(table)}`;

  if (cursorColumn === null) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(
        `INSERT INTO main.${quoteIdent(table)} (${insertTargets})` +
          ` SELECT ${selectTargets} FROM ${sourceTable}`
      );
      const count = db.prepare(`SELECT count(*) AS count FROM main.${quoteIdent(table)}`).get() as {
        count: number;
      };
      db.exec('COMMIT');
      checkpointTruncate(db, 'main');
      return count.count;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  let cursor: string | null = null;
  for (;;) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const comparison = cursor === null ? 'IS NOT NULL' : '> ?';
      const parameters = cursor === null ? [] : [cursor];
      const result = db.run(
        `INSERT INTO main.${quoteIdent(table)} (${insertTargets})` +
          ` SELECT ${selectTargets} FROM ${sourceTable}` +
          ` WHERE ${quoteIdent(cursorColumn)} ${comparison}` +
          ` ORDER BY ${quoteIdent(cursorColumn)} LIMIT ${COPY_BATCH_ROWS}`,
        ...parameters
      );
      if (result.changes === 0) {
        db.exec('COMMIT');
        break;
      }
      const maxRow = db
        .prepare(
          `SELECT printf('%lld', max(${quoteIdent(cursorColumn)})) AS max FROM (` +
            `SELECT ${quoteIdent(cursorColumn)} FROM ${sourceTable}` +
            ` WHERE ${quoteIdent(cursorColumn)} ${comparison}` +
            ` ORDER BY ${quoteIdent(cursorColumn)} LIMIT ${COPY_BATCH_ROWS})`
        )
        .get(...parameters) as { max: string | null };
      db.exec('COMMIT');
      checkpointTruncate(db, 'main');
      if (maxRow.max === null) break;
      cursor = maxRow.max;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const counted = db.prepare(`SELECT count(*) AS count FROM main.${quoteIdent(table)}`).get() as {
    count: number;
  };
  return counted.count;
}

function restoreFtsConfig(db: Database, table: string): void {
  const configs = db
    .prepare(
      `SELECT k, v FROM ${quoteIdent(SRC_SCHEMA)}.${quoteIdent(`${table}_config`)} WHERE k != 'version'`
    )
    .all() as { k: string; v: string }[];
  for (const { k, v } of configs) {
    try {
      db.run(
        `INSERT INTO main.${quoteIdent(table)} (${quoteIdent(table)}, rank)` +
          ` VALUES(${quoteString(k)}, ?)`,
        v
      );
    } catch (error) {
      throw new Error(
        `Could not restore FTS option ${k}=${v} on ${table}; refusing to promote a database` +
          ` with reverted search settings: ${String(error)}`
      );
    }
  }
}

function reconcileSqliteSequence(db: Database): void {
  if (!tableExists(db, SRC_SCHEMA, 'sqlite_sequence')) return;
  if (!tableExists(db, 'main', 'sqlite_sequence')) {
    throw new Error('sqlite_sequence missing in rebuilt database');
  }
  db.exec(`
    UPDATE main.sqlite_sequence AS dst
    SET seq = max(dst.seq, (
      SELECT origin.seq FROM ${quoteIdent(SRC_SCHEMA)}.sqlite_sequence AS origin
      WHERE origin.name = dst.name
    ))
    WHERE EXISTS (
      SELECT 1 FROM ${quoteIdent(SRC_SCHEMA)}.sqlite_sequence AS origin
      WHERE origin.name = dst.name
    )
  `);
  db.exec(`
    INSERT INTO main.sqlite_sequence (name, seq)
    SELECT origin.name, origin.seq FROM ${quoteIdent(SRC_SCHEMA)}.sqlite_sequence AS origin
    WHERE NOT EXISTS (SELECT 1 FROM main.sqlite_sequence AS dst WHERE dst.name = origin.name)
  `);
}

export function createRebuiltDatabase(oldPath: string, newPath: string): Database {
  if (existsSync(newPath)) {
    throw new Error(`Refusing to overwrite existing rebuild target: ${newPath}`);
  }

  const sourceEncodingDb = new Database(oldPath, { readonly: true });
  let sourceEncoding = 'UTF-8';
  try {
    sourceEncoding = (sourceEncodingDb.prepare('PRAGMA encoding').get() as { encoding: string })
      .encoding;
  } finally {
    sourceEncodingDb.close();
  }

  try {
    const stat = lstatSync(newPath);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to write through a symlink at the rebuild target: ${newPath}; remove` +
          ` the symlink and retry`
      );
    }
    throw new Error(`Refusing to overwrite existing rebuild target: ${newPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const db = new Database(newPath);
  try {
    applyOriginalMetadata(oldPath, newPath);
    if (sourceEncoding !== 'UTF-8') {
      db.exec(`PRAGMA encoding = ${quoteString(sourceEncoding)}`);
    }
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('PRAGMA cache_size = -131072');
    db.exec(`ATTACH DATABASE ${quoteString(oldPath)} AS ${quoteIdent(SRC_SCHEMA)}`);

    const schemaRows = readSchema(db, SRC_SCHEMA);
    const virtualTablesAll = schemaRows.filter(
      (row) => row.type === 'table' && isVirtualTable(row)
    );
    assertFts5(virtualTablesAll);
    const optionsByName = new Map<string, Map<string, string>>();
    for (const row of virtualTablesAll)
      optionsByName.set(row.name, ftsTopLevelOptions(row.sql ?? ''));
    const modes = ftsModes(virtualTablesAll);
    for (const row of virtualTablesAll) {
      const contentName = ftsContentOption(row.sql ?? '');
      if (contentName === null) continue;
      const reserved = `${row.name.toLowerCase()}_content`;
      if (contentName.toLowerCase() === reserved) {
        throw new Error(
          `Table ${contentName} uses the reserved FTS5 shadow naming of virtual table` +
            ` ${row.name}; SQLite blocks writes to it once the index exists, so rename` +
            ` the table or the index before rebuilding`
        );
      }
    }
    const { plainTables, virtualTables, otherObjects } = classifySchema(
      schemaRows,
      modes,
      optionsByName
    );

    const startedAt = Date.now();
    for (const row of dependencyOrder(plainTables, foreignKeyDependencies(db, plainTables))) {
      db.exec(row.sql as string);
    }
    for (const row of virtualTables) {
      db.exec(row.sql as string);
    }
    const internalVirtual = virtualTables.filter((row) => modes.get(row.name) === 'internal');
    for (const row of internalVirtual) restoreFtsConfig(db, row.name);
    for (const row of plainTables) {
      const count = copyTableData(db, row.name);
      console.log(`Copied ${row.name}: ${count} rows`);
    }
    for (const row of internalVirtual) {
      const count = copyTableData(db, row.name);
      console.log(`Copied FTS content ${row.name}: ${count} rows`);
    }
    db.exec('PRAGMA main.incremental_vacuum');
    const views = otherObjects.filter((row) => row.type === 'view');
    for (const row of views) {
      db.exec(row.sql as string);
    }
    const preRebuildIndexes = otherObjects.filter((row) => row.type === 'index');
    for (const row of preRebuildIndexes) {
      db.exec(row.sql as string);
    }
    reconcileSqliteSequence(db);
    for (const row of virtualTables) {
      if (modes.get(row.name) === 'internal') continue;
      restoreFtsConfig(db, row.name);
      db.exec(
        `INSERT INTO main.${quoteIdent(row.name)} (${quoteIdent(row.name)}) VALUES('rebuild')`
      );
      db.exec('PRAGMA main.incremental_vacuum');
      console.log(`Rebuilt FTS index ${row.name}`);
    }
    for (const row of otherObjects) {
      if (row.type === 'view' || row.type === 'index') continue;
      db.exec(row.sql as string);
    }
    const userVersion = db.prepare(`PRAGMA ${quoteIdent(SRC_SCHEMA)}.user_version`).get() as {
      user_version: number;
    };
    db.exec(`PRAGMA main.user_version = ${userVersion.user_version}`);
    const applicationId = db.prepare(`PRAGMA ${quoteIdent(SRC_SCHEMA)}.application_id`).get() as {
      application_id: number;
    };
    db.exec(`PRAGMA main.application_id = ${applicationId.application_id}`);

    console.log(`Import completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function verifyRebuiltDatabase(
  db: Database,
  options: { fullIntegrity: boolean } = { fullIntegrity: false }
): string[] {
  const failures: string[] = [];
  const pragma = options.fullIntegrity ? 'integrity_check' : 'quick_check';
  const integrityRows = db.prepare(`PRAGMA main.${pragma}`).values() as unknown[][];
  const integrityTexts = integrityRows.map((row) => String(row[0]));
  if (integrityTexts.length !== 1 || integrityTexts[0] !== 'ok') {
    failures.push(`${pragma}: ${integrityTexts.join(' | ')}`);
  }

  const foreignKeyRows = db.prepare('PRAGMA main.foreign_key_check').values() as unknown[][];
  if (foreignKeyRows.length > 0) {
    failures.push(
      `foreign_key_check reported ${foreignKeyRows.length} violation(s): ` +
        foreignKeyRows
          .slice(0, 5)
          .map((row) => row.join('.'))
          .join('; ')
    );
  }

  const schemaRows = readSchema(db, SRC_SCHEMA);
  const virtualTablesAll = schemaRows.filter((row) => row.type === 'table' && isVirtualTable(row));
  const optionsByName = new Map<string, Map<string, string>>();
  for (const row of virtualTablesAll)
    optionsByName.set(row.name, ftsTopLevelOptions(row.sql ?? ''));
  const modes = ftsModes(virtualTablesAll);
  const { plainTables, virtualTables } = classifySchema(schemaRows, modes, optionsByName);

  for (const row of plainTables) {
    const srcCount = db
      .prepare(`SELECT count(*) AS count FROM ${quoteIdent(SRC_SCHEMA)}.${quoteIdent(row.name)}`)
      .get() as { count: number };
    const mainCount = db
      .prepare(`SELECT count(*) AS count FROM main.${quoteIdent(row.name)}`)
      .get() as { count: number };
    if (srcCount.count !== mainCount.count) {
      failures.push(
        `row count mismatch for ${row.name}: source ${srcCount.count} vs rebuilt ${mainCount.count}`
      );
    }
  }

  for (const row of virtualTables) {
    const srcCount = db
      .prepare(`SELECT count(*) AS count FROM ${quoteIdent(SRC_SCHEMA)}.${quoteIdent(row.name)}`)
      .get() as { count: number };
    const mainCount = db
      .prepare(`SELECT count(*) AS count FROM main.${quoteIdent(row.name)}`)
      .get() as { count: number };
    if (srcCount.count !== mainCount.count) {
      failures.push(
        `row count mismatch for FTS table ${row.name}: source ${srcCount.count}` +
          ` vs rebuilt ${mainCount.count}`
      );
    }
    try {
      db.exec(
        `INSERT INTO main.${quoteIdent(row.name)} (${quoteIdent(row.name)}, rank)` +
          ` VALUES('integrity-check', 1)`
      );
    } catch (error) {
      failures.push(`FTS integrity-check failed for ${row.name}: ${(error as Error).message}`);
    }
  }

  const srcObjects = new Map(
    readSchema(db, SRC_SCHEMA).map((row) => [`${row.type}:${row.name}`, row.sql])
  );
  const mainObjects = new Map(
    readSchema(db, 'main').map((row) => [`${row.type}:${row.name}`, row.sql])
  );
  for (const [key, sql] of srcObjects) {
    if (!mainObjects.has(key)) failures.push(`schema object missing in rebuild: ${key}`);
    else if (mainObjects.get(key) !== sql) failures.push(`schema object differs: ${key}`);
  }
  for (const key of mainObjects.keys()) {
    if (!srcObjects.has(key)) failures.push(`unexpected schema object in rebuild: ${key}`);
  }

  const srcVersion = db.prepare(`PRAGMA ${quoteIdent(SRC_SCHEMA)}.user_version`).get() as {
    user_version: number;
  };
  const mainVersion = db.prepare('PRAGMA main.user_version').get() as { user_version: number };
  if (srcVersion.user_version !== mainVersion.user_version) {
    failures.push(
      `user_version mismatch: source ${srcVersion.user_version} vs rebuilt ${mainVersion.user_version}`
    );
  }

  const srcApplicationId = db.prepare(`PRAGMA ${quoteIdent(SRC_SCHEMA)}.application_id`).get() as {
    application_id: number;
  };
  const mainApplicationId = db.prepare('PRAGMA main.application_id').get() as {
    application_id: number;
  };
  if (srcApplicationId.application_id !== mainApplicationId.application_id) {
    failures.push(
      `application_id mismatch: source ${srcApplicationId.application_id} vs rebuilt` +
        ` ${mainApplicationId.application_id}`
    );
  }

  const freelist = db.prepare('PRAGMA main.freelist_count').get() as { freelist_count: number };
  if (freelist.freelist_count !== 0) {
    failures.push(`rebuilt database still has ${freelist.freelist_count} freelist pages`);
  }

  const autoVacuum = db.prepare('PRAGMA main.auto_vacuum').get() as { auto_vacuum: number };
  if (autoVacuum.auto_vacuum !== 2) {
    failures.push(`auto_vacuum is ${autoVacuum.auto_vacuum}, expected 2 (INCREMENTAL)`);
  }

  return failures;
}

function checkpointTruncate(db: Database, schema: string): void {
  const result = db.prepare(`PRAGMA ${quoteIdent(schema)}.wal_checkpoint(TRUNCATE)`).get() as {
    busy: number;
  };
  if (result.busy !== 0) {
    throw new Error(
      `WAL checkpoint of the ${schema} database is blocked by another reader` +
        ` (busy=${result.busy}); close every connection to it and retry`
    );
  }
}

export function swapRebuiltDatabase(
  db: Database,
  dbPath: string,
  newPath: string,
  backupPath: string
): void {
  checkpointTruncate(db, 'main');
  db.exec(`DETACH DATABASE ${quoteIdent(SRC_SCHEMA)}`);
  db.close();

  if (existsSync(`${newPath}-wal`) && statSync(`${newPath}-wal`).size > 0) {
    throw new Error(`Rebuilt database WAL is not empty after checkpoint: ${newPath}-wal`);
  }

  applyOriginalMetadata(dbPath, newPath);
  performFileSwap(dbPath, newPath, backupPath);
}

export function performFileSwap(dbPath: string, newPath: string, backupPath: string): void {
  try {
    carrySidecar(`${dbPath}-wal`, `${backupPath}-wal`);
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(backupPath, { force: true });
    preserveOriginal(dbPath, backupPath);
    renameSync(newPath, dbPath);
    carrySidecar(`${newPath}-wal`, `${dbPath}-wal`);
    rmSync(`${newPath}-shm`, { force: true });
  } catch (error) {
    if (!existsSync(dbPath) && existsSync(backupPath)) {
      renameSync(backupPath, dbPath);
      if (!existsSync(`${dbPath}-wal`) && existsSync(`${backupPath}-wal`)) {
        renameSync(`${backupPath}-wal`, `${dbPath}-wal`);
      }
      if (!existsSync(`${dbPath}-shm`) && existsSync(`${backupPath}-shm`)) {
        renameSync(`${backupPath}-shm`, `${dbPath}-shm`);
      }
    }
    throw error;
  }
}

function carrySidecar(path: string, target: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).size > 0) {
    renameSync(path, target);
  } else {
    rmSync(path, { force: true });
  }
}

function readDatabaseStats(dbPath: string): {
  pageBytes: number;
  pageCount: number;
  freelist: number;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const pageSize = db.prepare('PRAGMA page_size').get() as { page_size: number };
    const pageCount = db.prepare('PRAGMA page_count').get() as { page_count: number };
    const freelist = db.prepare('PRAGMA freelist_count').get() as { freelist_count: number };
    return {
      pageBytes: pageSize.page_size,
      pageCount: pageCount.page_count,
      freelist: freelist.freelist_count,
    };
  } finally {
    db.close();
  }
}

function assertFreeDisk(dbPath: string, requiredBytes: number): void {
  const stats = statfsSync(dirname(dbPath));
  const freeBytes = stats.bsize * stats.bavail;
  if (freeBytes < requiredBytes) {
    throw new Error(
      `Not enough free disk space: need ${(requiredBytes / 1024 ** 3).toFixed(
        1
      )} GiB, have ${(freeBytes / 1024 ** 3).toFixed(1)} GiB on ${dirname(dbPath)}`
    );
  }
}

function removePartialRebuild(newPath: string): void {
  rmSync(newPath, { force: true });
  rmSync(`${newPath}-wal`, { force: true });
  rmSync(`${newPath}-shm`, { force: true });
}

export async function run(options: Options): Promise<void> {
  let dbPath = options.dbPath;
  if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  dbPath = realpathSync(dbPath);
  options.dbPath = dbPath;
  const linkCount = statSync(dbPath).nlink;
  if (linkCount > 1) {
    throw new Error(
      `Database ${dbPath} has ${linkCount} hard links; lock files are per-path, so another` +
        ` name may be the one a running daemon is guarding. Remove the extra hard links` +
        ` and retry.`
    );
  }

  const lockAcquired = acquireDatabaseLock(dbPath);
  if (!lockAcquired) {
    const livePid = liveLockHolderPid(`${dbPath}.lock`);
    const hint = staleTakeoverHint(dbPath);
    if (livePid !== null && !options.force) {
      throw new Error(
        `Refusing to rebuild a database used by live HyperNeo daemon PID ${livePid}.\n` +
          `Stop the daemon first, or pass --force if you understand the risk.\n` +
          `Database: ${dbPath}`
      );
    }
    if (livePid !== null) {
      console.warn(
        `Warning: daemon lock is held by live PID ${livePid}; continuing due to --force.`
      );
    } else {
      throw new Error(
        `Could not acquire the daemon lock for ${dbPath} after repeated attempts.${hint}`
      );
    }
  }

  try {
    await runWithLockHeld(options, dbPath);
  } finally {
    releaseDatabaseLock();
  }
}

async function runWithLockHeld(options: Options, dbPath: string): Promise<void> {
  if (existsSync(`${dbPath}-wal`) && statSync(`${dbPath}-wal`).size > 0) {
    console.log('Checkpointing WAL of the original database...');
    const fold = new Database(dbPath);
    try {
      checkpointTruncate(fold, 'main');
    } finally {
      fold.close();
    }
  }

  const beforeStats = readDatabaseStats(dbPath);
  const beforeSize = statSync(dbPath).size;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const nonce = `${process.pid}-${Math.floor(Math.random() * 2 ** 48).toString(36)}`;
  const newPath = `${dbPath}.rebuild-${timestamp}-${nonce}.db`;
  const backupPath = `${dbPath}.pre-rebuild-${timestamp}`;

  const linksSupported = hardLinksSupported(dirname(dbPath));
  const backupBudgetBytes = linksSupported ? 0 : beforeSize;
  assertFreeDisk(dbPath, beforeSize + backupBudgetBytes + MIN_FREE_HEADROOM_BYTES);

  console.log(`Rebuilding ${dbPath}`);
  console.log(
    `  original: ${(beforeSize / 1024 ** 3).toFixed(2)} GiB,` +
      ` freelist ${beforeStats.freelist} of ${beforeStats.pageCount} pages` +
      ` (${((beforeStats.freelist * beforeStats.pageBytes) / 1024 ** 3).toFixed(2)} GiB reclaimable)`
  );
  console.log(`  rebuilt file: ${newPath}`);
  console.log(`  backup after swap: ${backupPath}`);

  let db: Database;
  try {
    db = createRebuiltDatabase(dbPath, newPath);
  } catch (error) {
    removePartialRebuild(newPath);
    throw error;
  }
  let failures: string[];
  try {
    failures = verifyRebuiltDatabase(db, { fullIntegrity: options.fullIntegrity });
  } catch (error) {
    failures = [`verification crashed: ${(error as Error).message}`];
  }

  if (failures.length > 0) {
    db.close();
    removePartialRebuild(newPath);
    throw new Error(
      `Verification failed; the original database was not touched.\n  ${failures.join('\n  ')}`
    );
  }
  console.log('Verification passed: row counts, schema objects, integrity, FTS indexes');

  if (options.noSwap) {
    checkpointTruncate(db, 'main');
    db.exec(`DETACH DATABASE ${quoteIdent(SRC_SCHEMA)}`);
    db.close();
    applyOriginalMetadata(dbPath, newPath);
    console.log(`--no-swap: rebuilt database left at ${newPath}`);
    console.log(`The snapshot is only valid while ${dbPath} stays untouched:`);
    console.log(`  keep the daemon stopped, run the swap immediately, and if anything`);
    console.log(`  wrote to ${dbPath} in the meantime, discard ${newPath} and re-run the rebuild.`);
    console.log(
      `  mv ${shellQuote(`${dbPath}-wal`)} ${shellQuote(`${backupPath}-wal`)}   # only if it exists`
    );
    console.log(`  rm -f ${shellQuote(`${dbPath}-shm`)}`);
    if (hardLinksSupported(dirname(dbPath))) {
      console.log(
        `  rm -f ${shellQuote(backupPath)} && ln ${shellQuote(dbPath)} ${shellQuote(backupPath)}`
      );
    } else {
      console.log(`  cp -p ${shellQuote(dbPath)} ${shellQuote(backupPath)}`);
      console.log(
        `  chown --reference=${shellQuote(dbPath)} ${shellQuote(backupPath)}  # only when copying as another account`
      );
    }
    console.log(`  mv -f ${shellQuote(newPath)} ${shellQuote(dbPath)}`);
    return;
  }

  checkpointTruncate(db, 'main');
  const afterFreelist = db.prepare('PRAGMA main.freelist_count').get() as {
    freelist_count: number;
  };
  const afterSize = statSync(newPath).size;

  swapRebuiltDatabase(db, dbPath, newPath, backupPath);

  console.log('Swap complete.');
  console.log(
    `  size: ${(beforeSize / 1024 ** 3).toFixed(2)} GiB -> ${(afterSize / 1024 ** 3).toFixed(2)} GiB` +
      ` (reclaimed ${((beforeSize - afterSize) / 1024 ** 3).toFixed(2)} GiB)`
  );
  console.log(`  freelist: ${afterFreelist.freelist_count} pages`);
  console.log(`  backup (kept, not deleted by this script): ${backupPath}`);
  console.log('Start the daemon and confirm a clean boot before archiving the backup.');
}

async function confirm(options: Options): Promise<void> {
  console.log(`About to rebuild the HyperNeo daemon database:
  Database: ${options.dbPath}
  Strategy: export-and-swap into a new file (auto_vacuum=INCREMENTAL, WAL)
  Verify:   row counts, schema objects, integrity, FTS indexes
  Swap:     ${options.noSwap ? 'no (--no-swap; file is left in place)' : 'yes'}
  Backup:   original file renamed and kept next to the new one
`);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let input: string;
  try {
    input = await readline.question('Type "rebuild" to continue: ');
  } finally {
    readline.close();
  }
  if (input.trim() !== 'rebuild') {
    throw new Error('Aborted by user');
  }
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.yes) await confirm(options);
  await run(options);
}
