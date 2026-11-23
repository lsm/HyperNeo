import { searchNeoCards } from './neo-card-search.ts';
import { readHyperneoTurnEnds } from './hyperneo-turn-ends-read.ts';
import { readHyperneoTurnFacts } from './hyperneo-turn-facts-read.ts';
import { readClaudeDesktopRecordFiles } from './claude-desktop-read.ts';
import { readCodexSnapshot } from './codex-desktop-read.ts';
import { cursorWorkspaceFolder } from './cursor-desktop-path.ts';
import { countPendingTurns, readPendingTurns } from './turn-vectors.ts';
import { readMessageFacts } from '../lib/neo/message-status.ts';
import { readMessageFeed } from './sdk-message-feed-read.ts';
import { Database } from './sqlite-compat.ts';
import { pathToFileURL } from 'node:url';
import type {
  CursorDesktopRead,
  CursorDesktopSession,
} from '../lib/drivers/cursor-desktop-discovery.ts';
import { readCopilotDesktop } from './copilot-desktop-read.ts';
import { readAntigravityDesktop } from './antigravity-desktop-read.ts';
import { SDKMessageRepository } from './repositories/sdk-message-repository.ts';
import { subscribeToStructuredLogs } from '../lib/logger.ts';
import {
  projectSDKStatusPage,
  projectSDKStatusMessage,
  readSDKMessagePage,
  sdkReadLogMetadata,
  type SDKReadResult,
  type SDKStatusReply,
  type SDKStatusRequest,
} from './sdk-status-reader.ts';

const worker = globalThis as unknown as {
  onmessage: (event: { data: SDKStatusRequest }) => void;
  postMessage(reply: SDKStatusReply): void;
};
let db: Database | null = null;
let repository: SDKMessageRepository | null = null;
let workerOperation = 'sdk-status';

function readCursorDesktop({ statePath, query }: CursorDesktopRead, readonlyUri = false) {
  let app: Database | undefined;
  try {
    app = new Database(statePath, { readonly: true, readonlyUri });
    app.exec('PRAGMA busy_timeout = 500');
    const index = app
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'composerHeaders'")
      .get();
    if (!index) return [];
    const text = query.text?.toLowerCase() ?? '';
    const windows = process.platform === 'win32';
    const folderFilter = windows ? query.folder?.toLowerCase() : query.folder;
    const matches: CursorDesktopSession[] = [];
    const rows = app
      .prepare<CursorDesktopSession & { marshalled: number | null }>(`
      WITH headers AS (
        SELECT composerId AS id, isArchived AS archived, COALESCE(recency, 0) AS updatedAt,
               CASE WHEN json_valid(CAST(value AS TEXT)) THEN CAST(value AS TEXT) ELSE '{}' END AS header
          FROM composerHeaders
         WHERE NOT isSubagent AND (? OR NOT isArchived)
           AND composerId = COALESCE(?, composerId)
      ), sessions AS (
        SELECT id,
               COALESCE(NULLIF(trim(json_extract(header, '$.name')), ''), 'Untitled Cursor session') AS title,
               json_extract(header, '$.workspaceIdentifier.uri.path') AS folder,
               json_extract(header, '$.workspaceIdentifier.uri."$mid"') AS marshalled,
               updatedAt, archived
          FROM headers
         WHERE json_extract(header, '$.workspaceIdentifier.uri.scheme') = 'file'
           AND COALESCE(json_extract(header, '$.workspaceIdentifier.uri.authority'), '') = ''
      )
      SELECT id, title, folder, marshalled, updatedAt, archived FROM sessions
       WHERE typeof(id) = 'text' AND id <> '' AND typeof(folder) = 'text'
         AND instr(id, ?) = 1
       ORDER BY updatedAt DESC, id
    `)
      .iterate(Number(query.includeClosed), query.id ?? null, query.idPrefix ?? '');
    for (const { folder: path, marshalled, ...session } of rows) {
      if (matches.length >= query.limit) break;
      const folder = cursorWorkspaceFolder(path, marshalled === 1, windows);
      if (!folder || (folderFilter && (windows ? folder.toLowerCase() : folder) !== folderFilter))
        continue;
      if (
        text &&
        !session.title.toLowerCase().includes(text) &&
        !folder.toLowerCase().includes(text)
      )
        continue;
      matches.push({ ...session, folder });
    }
    return matches;
  } catch (error) {
    if (readonlyUri || !/unable to open database file|readonly database/.test(String(error)))
      throw error;
  } finally {
    app?.close();
  }
  const url = pathToFileURL(statePath);
  url.searchParams.set('immutable', '1');
  return readCursorDesktop({ statePath: url.href, query }, true);
}

subscribeToStructuredLogs((log) => {
  if (log.module === 'hyperneo:daemon:sqlite.query')
    worker.postMessage({
      log: { ...log, metadata: sdkReadLogMetadata(log.metadata, workerOperation) },
    });
});

worker.onmessage = ({ data }) => {
  const { id, epoch, args } = data,
    started = performance.now(),
    queueMs = Date.now() - data.sentAt;
  workerOperation = args
    ? 'cardQuery' in args
      ? 'card-search'
      : 'query' in args
        ? 'work-search'
        : 'hyperneoTurnFacts' in args
          ? 'hyperneo-turn-facts'
          : 'hyperneoTurnEnds' in args
            ? 'hyperneo-turn-ends'
            : 'claudeRecords' in args
              ? 'claude-records'
              : 'codexSnapshot' in args
                ? 'codex-snapshot'
                : 'copilotDesktop' in args
                  ? 'copilot-desktop'
                  : 'cursorDesktop' in args
                    ? 'cursor-desktop'
                    : 'turnVectors' in args
                      ? 'turn-vectors'
                      : 'neoMessageStatus' in args
                        ? 'neo-message-status'
                        : 'feed' in args
                          ? 'message-feed'
                          : 'page' in args
                            ? 'sdk-page'
                            : 'antigravityDesktop' in args
                              ? 'antigravity-desktop'
                              : 'sdk-status'
    : 'close';
  try {
    let result: SDKReadResult | null = null;
    if (!args) {
      db?.close();
      db = null;
      repository = null;
    } else if ('claudeRecords' in args) {
      result = readClaudeDesktopRecordFiles(args.claudeRecords.sessionsDir);
    } else if ('copilotDesktop' in args) {
      result = readCopilotDesktop(args.copilotDesktop);
    } else if ('cursorDesktop' in args) {
      result = readCursorDesktop(args.cursorDesktop);
    } else if ('antigravityDesktop' in args) {
      result = readAntigravityDesktop(args.antigravityDesktop);
    } else if ('codexSnapshot' in args) {
      result = readCodexSnapshot(
        args.codexSnapshot.statePath,
        args.codexSnapshot.includeClosed,
        args.codexSnapshot.idPrefix,
        args.codexSnapshot.fullTitles
      );
    } else {
      if (!db) {
        db = new Database(data.dbPath, {
          readonly: true,
          queryObservability: data.queryObservability,
        });
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
        repository = new SDKMessageRepository(db);
      }
      result = db.transaction(() => {
        if ('cardQuery' in args) {
          return searchNeoCards(
            (sql, bindings) => db!.prepare(sql).all(...bindings),
            args.cardQuery.query,
            args.cardQuery.cursor,
            args.cardQuery.limit
          );
        }
        if ('query' in args) {
          const semantic = args.semantic
            ? { model: args.semantic.model, vector: Float32Array.from(args.semantic.vector) }
            : undefined;
          return repository!.searchWorkChats(args.query, args.limit, semantic, args.kinds);
        }
        if ('hyperneoTurnEnds' in args) {
          return readHyperneoTurnEnds(
            db!,
            args.hyperneoTurnEnds.sessionId,
            args.hyperneoTurnEnds.since
          );
        }
        if ('hyperneoTurnFacts' in args) {
          const { sessionId, cursor, limit } = args.hyperneoTurnFacts;
          return readHyperneoTurnFacts(db!, sessionId, cursor, limit);
        }
        if ('turnVectors' in args) {
          const { model, dimensions, limit } = args.turnVectors;
          return limit === null
            ? countPendingTurns(db!, model, dimensions)
            : readPendingTurns(db!, model, dimensions, limit);
        }
        if ('neoMessageStatus' in args) return readMessageFacts(db!, args.neoMessageStatus);
        if ('feed' in args) return readMessageFeed(db!, args);
        if ('page' in args) return readSDKMessagePage(repository!, args);
        return projectSDKStatusPage(
          repository!.getUserMessagesByStatus(
            args.sessionId,
            args.status,
            args.limit,
            'asc',
            projectSDKStatusMessage
          ),
          args.status
        );
      })();
    }
    worker.postMessage({
      id,
      epoch,
      result,
      finishedAt: Date.now(),
      workerMs: performance.now() - started,
      queueMs,
    });
  } catch (error) {
    worker.postMessage({
      id,
      epoch,
      error: error instanceof Error ? error.message : String(error),
      finishedAt: Date.now(),
      workerMs: performance.now() - started,
      queueMs,
    });
  }
};

worker.postMessage({ ready: true });
