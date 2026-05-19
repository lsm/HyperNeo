#!/usr/bin/env bun
/**
 * Offline maintenance for the NeoKai message search FTS index.
 *
 * Usage:
 *   bun run scripts/maintain-message-search-db.ts [--db-path /path/to/daemon.db] [--yes]
 *
 * The daemon must be stopped unless --force is provided. The script checkpoints WAL,
 * creates a timestamped backup in the standard backups/ directory, optimizes FTS,
 * and optionally VACUUMs the database to reclaim disk space.
 */

import { Database as BunDatabase } from 'bun:sqlite';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DB_PATH = join(homedir(), '.neokai', 'data', 'daemon.db');
const BACKUPS_TO_KEEP = 3;

type Options = {
	dbPath: string;
	yes: boolean;
	force: boolean;
	skipVacuum: boolean;
};

function parseArgs(argv: string[]): Options {
	const options: Options = {
		dbPath: process.env.DB_PATH || DEFAULT_DB_PATH,
		yes: false,
		force: false,
		skipVacuum: false,
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
		} else if (arg === '--skip-vacuum') {
			options.skipVacuum = true;
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
	console.log(`Usage: bun run scripts/maintain-message-search-db.ts [options]

Options:
  --db-path <path>  Database path (default: ${DEFAULT_DB_PATH})
  -y, --yes        Run without confirmation prompt
  --skip-vacuum    Optimize FTS but do not run VACUUM
  --force          Ignore a live daemon lock (not recommended)
  -h, --help       Show this help
`);
}

function assertDaemonStopped(dbPath: string, force: boolean): void {
	const lockPath = `${dbPath}.lock`;
	if (!existsSync(lockPath)) return;

	const raw = readFileSync(lockPath, 'utf-8').trim();
	const pid = Number.parseInt(raw, 10);
	if (!Number.isFinite(pid) || !isProcessAlive(pid) || pid === process.pid) return;
	if (force) {
		console.warn(`Warning: daemon lock is held by live PID ${pid}; continuing due to --force.`);
		return;
	}

	throw new Error(
		`Refusing to maintain a database used by live NeoKai daemon PID ${pid}.\n` +
			`Stop the daemon first, or pass --force if you understand the risk.\n` +
			`Database: ${dbPath}`
	);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function createBackup(dbPath: string): string {
	const backupDir = join(dirname(dbPath), 'backups');
	mkdirSync(backupDir, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupPath = join(backupDir, `daemon-${timestamp}.db`);
	copyFileSync(dbPath, backupPath);
	cleanupOldBackups(backupDir, BACKUPS_TO_KEEP);
	return backupPath;
}

function cleanupOldBackups(backupDir: string, keepCount: number): void {
	const backups = readdirSync(backupDir)
		.filter((name) => name.startsWith('daemon-') && name.endsWith('.db'))
		.map((name) => ({
			name,
			path: join(backupDir, name),
			mtime: statSync(join(backupDir, name)).mtime.getTime(),
		}))
		.sort((a, b) => b.mtime - a.mtime);

	for (const backup of backups.slice(keepCount)) {
		unlinkSync(backup.path);
	}
}

function tableExists(db: BunDatabase, tableName: string): boolean {
	const row = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
		.get(tableName) as { name?: string } | undefined;
	return !!row?.name;
}

async function confirm(options: Options): Promise<void> {
	if (options.yes) return;
	console.log(`About to maintain NeoKai message search DB:
  Database: ${options.dbPath}
  Backup:   yes, standard backups/ directory
  Optimize: yes
  VACUUM:   ${options.skipVacuum ? 'no' : 'yes'}
`);
	process.stdout.write('Type "maintain" to continue: ');
	const input = await new Response(Bun.stdin.stream()).text();
	if (input.trim() !== 'maintain') {
		throw new Error('Aborted by user');
	}
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync(options.dbPath)) {
	throw new Error(`Database not found: ${options.dbPath}`);
}
assertDaemonStopped(options.dbPath, options.force);
await confirm(options);

const beforeSize = statSync(options.dbPath).size;
const db = new BunDatabase(options.dbPath);
try {
	console.log('Checkpointing WAL before backup...');
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

	console.log('Creating backup...');
	const backupPath = createBackup(options.dbPath);
	console.log(`Backup created: ${backupPath}`);

	if (tableExists(db, 'message_search_fts')) {
		console.log('Optimizing message_search_fts...');
		db.exec(`INSERT INTO message_search_fts(message_search_fts) VALUES('optimize')`);
	} else {
		console.log('message_search_fts not found; skipping FTS optimize.');
	}

	if (!options.skipVacuum) {
		console.log('Running VACUUM. This may take a while...');
		db.exec('VACUUM');
	}

	console.log('Checkpointing WAL after maintenance...');
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} finally {
	db.close();
}

const afterSize = statSync(options.dbPath).size;
console.log(
	`Done. Database size: ${(beforeSize / 1024 / 1024).toFixed(1)} MiB → ${(
		afterSize / 1024 / 1024
	).toFixed(1)} MiB`
);
