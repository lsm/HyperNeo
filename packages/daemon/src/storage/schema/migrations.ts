import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { runMigration94 as runMigration94External } from './m94-backfill-workflow-templates.ts';
import { runMigration106 as runMigration106External } from './m106-backfill-agent-templates.ts';
import { runMigration170 as runMigration170External } from './m170-backfill-missing-preset-agents.ts';
import { runMigration171 } from './m171-backfill-post-approval-review-channels.ts';
import { runMigration172 as runMigration172External } from './m172-backfill-orphaned-preset-agents.ts';
import { runMigration184 as runMigration184External } from './m184-backfill-reviewer-bash-tools.ts';
import { runMigration185 as runMigration185External } from './m185-workflow-event-subscriptions.ts';
import { runMigration196 as runMigration196External } from './m196-scope-reviewer-bash-patterns.ts';
import { runMigration198 } from './m198-session-counters.ts';
import { RESERVED_SPACE_AGENT_HANDLES, slugify, validateSlug } from '../../lib/space/slug.ts';
import {
  deriveArtifactKey,
  isArtifactShape,
  normalizeLinkData,
  resolveLegacyShape,
  type ArtifactShape,
} from '@hyperneo/shared';
import { HIDDEN_SYSTEM_SUBTYPES } from '@hyperneo/shared/sdk/type-guards';
import { createEvolutionTables } from './evolution.ts';
import { createLongHorizonAgentTables } from './long-horizon-agents.ts';
import { runMigration206 } from './m206-restamp-reviewer-depth-tiers.ts';
import { runMigration207 } from './m207-restamp-reviewer-review-modes.ts';
import { runMigration208 } from './m208-restamp-reviewer-gate-artifact-fields.ts';
import { runMigration209 } from './m209-drop-inbox-agent-fk.ts';
import { runMigration213 } from './m213-inactivity-watchdog.ts';
import { runMigration214 } from './m214-backfill-session-agent-provenance.ts';
import { runMigration215 } from './m215-space-agent-model-pool.ts';
import { migrateLegacyLongHorizonAgentData } from '../../lib/space/agents/legacy-long-horizon-migration.ts';
import {
  findPendingMigrationSpaceReclaims,
  type MigrationSpaceReclaimRequest,
} from './migration-space-reclaim.ts';

export function runMigrations(
  db: BunDatabase,
  createBackup: () => void
): MigrationSpaceReclaimRequest[] {
  ensureMigrationMarkersTable(db);
  seedHistoricalMigrationMarkers(db);

  let backupCreated = false;
  const rewriteMigrationKeys = new Set<string>();
  const ensureBackup = (): void => {
    if (backupCreated) return;
    createBackup();
    backupCreated = true;
  };
  const run = (key: string, migration: () => void): void => {
    runMarkedMigration(db, key, migration, ensureBackup);
  };
  const rewrite = (key: string, migration: () => void): void => {
    rewriteMigrationKeys.add(key);
    runMarkedMigration(db, key, migration, ensureBackup);
  };

  run(migrationMarkerKey(1), () => runMigration1(db));

  run(migrationMarkerKey(2), () => runMigration2(db));

  run(migrationMarkerKey(3), () => runMigration3(db));

  run(migrationMarkerKey(4), () => runMigration4(db));

  run(migrationMarkerKey(5), () => runMigration5(db));

  run(migrationMarkerKey(6), () => runMigration6(db));

  run(migrationMarkerKey(7), () => runMigration7(db));

  run(migrationMarkerKey(8), () => runMigration8(db));

  rewrite(migrationMarkerKey(9), () => runMigration9(db));

  run(migrationMarkerKey(10), () => runMigration10(db));

  run(migrationMarkerKey(11), () => runMigration11(db));

  run(migrationMarkerKey(12), () => runMigration12(db));

  rewrite(migrationMarkerKey(13), () => runMigration13(db));

  rewrite('migration_room_cleanup', () => runMigrationRoomCleanup(db));

  rewrite(migrationMarkerKey(14), () => runMigration14(db));

  rewrite(migrationMarkerKey(15), () => runMigration15(db));

  rewrite(migrationMarkerKey(16), () => runMigration16(db));

  rewrite(migrationMarkerKey(17), () => runMigration17(db));

  rewrite(migrationMarkerKey(18), () => runMigration18(db));

  run(migrationMarkerKey(19), () => runMigration19(db));

  run(migrationMarkerKey(20), () => runMigration20(db));

  run(migrationMarkerKey(21), () => runMigration21(db));

  rewrite(migrationMarkerKey(22), () => runMigration22(db));

  run(migrationMarkerKey(23), () => runMigration23(db));

  rewrite(migrationMarkerKey(24), () => runMigration24(db));

  run(migrationMarkerKey(25), () => runMigration25(db));

  run(migrationMarkerKey(26), () => runMigration26(db));

  run(migrationMarkerKey(27), () => runMigration27(db));

  run(migrationMarkerKey(28), () => runMigration28(db));

  rewrite(migrationMarkerKey(29), () => runMigration29(db));

  run(migrationMarkerKey(30), () => runMigration30(db));

  rewrite(migrationMarkerKey(31), () => runMigration31(db));

  run(migrationMarkerKey(32), () => runMigration32(db));

  run(migrationMarkerKey(33), () => runMigration33(db));

  run(migrationMarkerKey(34), () => runMigration34(db));

  run(migrationMarkerKey(35), () => runMigration35(db));

  run(migrationMarkerKey(36), () => runMigration36(db));

  run(migrationMarkerKey(37), () => runMigration37(db));

  run(migrationMarkerKey(38), () => runMigration38(db));

  rewrite(migrationMarkerKey(39), () => runMigration39(db));

  rewrite(migrationMarkerKey(40), () => runMigration40(db));

  run(migrationMarkerKey(41), () => runMigration41(db));

  run(migrationMarkerKey(42), () => runMigration42(db));

  run(migrationMarkerKey(43), () => runMigration43(db));

  rewrite(migrationMarkerKey(44), () => runMigration44(db));

  rewrite(migrationMarkerKey(45), () => runMigration45(db));

  run(migrationMarkerKey(46), () => runMigration46(db));

  run(migrationMarkerKey(47), () => runMigration47(db));

  run(migrationMarkerKey(48), () => runMigration48(db));

  rewrite(migrationMarkerKey(49), () => runMigration49(db));

  run(migrationMarkerKey(50), () => runMigration50(db));

  rewrite(migrationMarkerKey(51), () => runMigration51(db));

  run(migrationMarkerKey(52), () => runMigration52(db));

  run(migrationMarkerKey(53), () => runMigration53(db));

  run(migrationMarkerKey(54), () => runMigration54(db));

  rewrite(migrationMarkerKey(55), () => runMigration55(db));

  rewrite(migrationMarkerKey(56), () => runMigration56(db));

  run(migrationMarkerKey(57), () => runMigration57(db));

  run(migrationMarkerKey(58), () => runMigration58(db));

  run(migrationMarkerKey(59), () => runMigration59(db));

  rewrite(migrationMarkerKey(60), () => runMigration60(db));

  run(migrationMarkerKey(61), () => runMigration61(db));

  rewrite(migrationMarkerKey(62), () => runMigration62(db));

  rewrite(migrationMarkerKey(63), () => runMigration63(db));

  run(migrationMarkerKey(64), () => runMigration64(db));

  run(migrationMarkerKey(65), () => runMigration65(db));

  rewrite(migrationMarkerKey(66), () => runMigration66(db));

  rewrite(migrationMarkerKey(67), () => runMigration67(db));
  run(migrationMarkerKey(68), () => runMigration68(db));
  run(migrationMarkerKey(69), () => runMigration69(db));
  run(migrationMarkerKey(70), () => runMigration70(db));
  run(migrationMarkerKey(71), () => runMigration71(db));
  run(migrationMarkerKey(72), () => runMigration72(db));
  rewrite(migrationMarkerKey(73), () => runMigration73(db));

  rewrite(migrationMarkerKey(74), () => runMigration74(db));

  run(migrationMarkerKey(75), () => runMigration75(db));

  rewrite(migrationMarkerKey(76), () => runMigration76(db));

  rewrite(migrationMarkerKey(77), () => runMigration77(db));

  run(migrationMarkerKey(78), () => runMigration78(db));

  rewrite(migrationMarkerKey(79), () => runMigration79(db));

  run(migrationMarkerKey(80), () => runMigration80(db));

  run(migrationMarkerKey(81), () => runMigration81(db));

  run(migrationMarkerKey(82), () => runMigration82(db));

  run(migrationMarkerKey(83), () => runMigration83(db));

  rewrite(migrationMarkerKey(84), () => runMigration84(db));

  run(migrationMarkerKey(85), () => runMigration85(db));

  rewrite(migrationMarkerKey(86), () => runMigration86(db));

  run(migrationMarkerKey(87), () => runMigration87(db));

  run(migrationMarkerKey(88), () => runMigration88(db));

  run(migrationMarkerKey(89), () => runMigration89(db));

  run(migrationMarkerKey(90), () => runMigration90(db));

  run(migrationMarkerKey(91), () => runMigration91(db));

  run(migrationMarkerKey(92), () => runMigration92(db));

  run(migrationMarkerKey(93), () => runMigration93(db));

  run(migrationMarkerKey(94), () => runMigration94(db));

  run(migrationMarkerKey(95), () => runMigration95(db));

  run(migrationMarkerKey(96), () => runMigration96(db));

  run(migrationMarkerKey(97), () => runMigration97(db));

  run(migrationMarkerKey(98), () => runMigration98(db));

  rewrite(migrationMarkerKey(99), () => runMigration99(db));

  run(migrationMarkerKey(100), () => runMigration100(db));

  run(migrationMarkerKey(101), () => runMigration101(db));

  run(migrationMarkerKey(102), () => runMigration102(db));

  rewrite(migrationMarkerKey(103), () => runMigration103(db));

  rewrite(migrationMarkerKey(104), () => runMigration104(db));

  run(migrationMarkerKey(105), () => runMigration105(db));

  run(migrationMarkerKey(106), () => runMigration106(db));

  run(migrationMarkerKey(107), () => runMigration107(db));

  run(migrationMarkerKey(108), () => runMigration108(db));

  rewrite(migrationMarkerKey(109), () => runMigration109(db));

  run(migrationMarkerKey(110), () => runMigration110(db));

  run(migrationMarkerKey(111), () => runMigration111(db));

  run(migrationMarkerKey(112), () => runMigration112(db));

  run(migrationMarkerKey(113), () => runMigration113(db));

  rewrite(migrationMarkerKey(114), () => runMigration114(db));

  run(migrationMarkerKey(115), () => runMigration115(db));

  run(migrationMarkerKey(116), () => runMigration116(db));

  run(migrationMarkerKey(117), () => runMigration117(db));

  run(migrationMarkerKey(118), () => runMigration118(db));

  run(migrationMarkerKey(119), () => runMigration119(db));

  run(migrationMarkerKey(120), () => runMigration120(db));

  run(migrationMarkerKey(121), () => runMigration121(db));

  run(migrationMarkerKey(122), () => runMigration122(db));

  run(migrationMarkerKey(123), () => runMigration123(db));

  rewrite(migrationMarkerKey(124), () => runMigration124(db));

  run(migrationMarkerKey(125), () => runMigration125(db));

  run(migrationMarkerKey(126), () => runMigration126(db));

  run(migrationMarkerKey(127), () => runMigration127(db));

  run(migrationMarkerKey(128), () => runMigration128(db));

  run(migrationMarkerKey(129), () => runMigration129(db));

  run(migrationMarkerKey(130), () => runMigration130(db));

  rewrite(migrationMarkerKey(131), () => runMigration131(db));

  run(migrationMarkerKey(132), () => runMigration132(db));

  run(migrationMarkerKey(133), () => runMigration133(db));

  run(migrationMarkerKey(134), () => runMigration134(db));

  run(migrationMarkerKey(135), () => runMigration135(db));

  rewrite(migrationMarkerKey(136), () => runMigration136(db));

  run(migrationMarkerKey(137), () => runMigration137(db));

  run(migrationMarkerKey(138), () => runMigration138(db));

  rewrite(migrationMarkerKey(139), () => runMigration139(db));

  run(migrationMarkerKey(140), () => runMigration140(db));

  rewrite(migrationMarkerKey(141), () => runMigration141(db));

  rewrite(migrationMarkerKey(142), () => runMigration142(db));

  rewrite(migrationMarkerKey(143), () => runMigration143(db));

  run(migrationMarkerKey(144), () => runMigration144(db));

  run(migrationMarkerKey(145), () => runMigration145(db));

  rewrite(migrationMarkerKey(146), () => runMigration146(db));

  run(migrationMarkerKey(147), () => runMigration147(db));

  run(migrationMarkerKey(148), () => runMigration148(db));

  run(migrationMarkerKey(149), () => runMigration149(db));

  run(migrationMarkerKey(150), () => runMigration150(db));

  run(migrationMarkerKey(151), () => runMigration151(db));

  run(migrationMarkerKey(152), () => runMigration152(db));

  run(migrationMarkerKey(153), () => runMigration153(db));

  run(migrationMarkerKey(154), () => runMigration154(db));

  run(migrationMarkerKey(155), () => runMigration155(db));

  run(migrationMarkerKey(156), () => runMigration156(db));

  run(migrationMarkerKey(157), () => runMigration157(db));

  run(migrationMarkerKey(158), () => runMigration158(db));
  rewrite(migrationMarkerKey(159), () => runMigration159(db));

  rewrite(migrationMarkerKey(160), () => runMigration160(db));

  run(migrationMarkerKey(161), () => runMigration161(db));

  run(migrationMarkerKey(162), () => runMigration162(db));

  let migration163Ran = false;
  run(migrationMarkerKey(163), () => {
    runMigration163(db);
    migration163Ran = true;
  });

  if (!migration163Ran) {
    reconcileSdkMessageReplacementProjection(db);
  }

  run(migrationMarkerKey(164), () => runMigration164(db));

  run(migrationMarkerKey(165), () => runMigration165(db));

  run(migrationMarkerKey(166), () => runMigration166(db));

  migrateLegacyArtifactsToShapes(db);

  rewrite(migrationMarkerKey(167), () => runMigration167(db));

  run(migrationMarkerKey(168), () => runMigration168(db));

  run(migrationMarkerKey(169), () => runMigration169(db));

  run(migrationMarkerKey(170), () => runMigration170(db));

  run(migrationMarkerKey(171), () => runMigration171(db));

  run(migrationMarkerKey(172), () => runMigration172(db));

  run(migrationMarkerKey(173), () => runMigration173(db));

  run(migrationMarkerKey(174), () => runMigration174(db));

  run(migrationMarkerKey(175), () => runMigration175(db));

  run(migrationMarkerKey(176), () => runMigration176(db));

  run(migrationMarkerKey(177), () => runMigration177(db));

  run(migrationMarkerKey(178), () => runMigration178(db));

  run(migrationMarkerKey(179), () => runMigration179(db));

  run(migrationMarkerKey(180), () => runMigration180(db));

  rewrite(migrationMarkerKey(181), () => runMigration181(db));

  run(migrationMarkerKey(182), () => runMigration182(db));

  rewrite(migrationMarkerKey(183), () => runMigration183(db));

  run(migrationMarkerKey(184), () => runMigration184(db));

  run(migrationMarkerKey(185), () => runMigration185(db));

  run(migrationMarkerKey(186), () => runMigration186(db));

  run(migrationMarkerKey(187), () => runMigration187(db));

  run(migrationMarkerKey(188), () => runMigration188(db));

  run(migrationMarkerKey(189), () => runMigration189(db));

  rewrite(migrationMarkerKey(190), () => runMigration190(db));

  run(migrationMarkerKey(191), () => runMigration191(db));

  run(migrationMarkerKey(192), () => runMigration192(db));

  run(migrationMarkerKey(193), () => runMigration193(db));

  run(migrationMarkerKey(194), () => runMigration194(db));

  rewrite(migrationMarkerKey(195), () => runMigration195(db));

  run(migrationMarkerKey(196), () => runMigration196(db));

  run(migrationMarkerKey(197), () => runMigration197(db));

  run(migrationMarkerKey(198), () => runMigration198(db));

  run(migrationMarkerKey(199), () => runMigration199(db));

  run(migrationMarkerKey(200), () => runMigration200(db));

  run(migrationMarkerKey(201), () => runMigration201(db));

  run(migrationMarkerKey(202), () => runMigration202(db));

  run(migrationMarkerKey(203), () => runMigration203(db));

  run(migrationMarkerKey(204), () => runMigration204(db));

  run(migrationMarkerKey(205), () => runMigration205(db));

  run(migrationMarkerKey(206), () => runMigration206(db));

  run(migrationMarkerKey(207), () => runMigration207(db));

  run(migrationMarkerKey(208), () => runMigration208(db));
  rewrite(migrationMarkerKey(209), () => runMigration209(db));

  run(migrationMarkerKey(210), () => runMigration210(db));

  rewrite(migrationMarkerKey(211), () => runMigration211(db));

  rewrite(migrationMarkerKey(212), () => runMigration212(db));

  run(migrationMarkerKey(213), () => runMigration213(db));

  run(migrationMarkerKey(214), () => runMigration214(db));

  run(migrationMarkerKey(215), () => runMigration215(db));

  return findPendingMigrationSpaceReclaims(db, [...rewriteMigrationKeys]);
}

function migrationMarkerKey(version: number): string {
  return `migration_${String(version).padStart(3, '0')}`;
}

function ensureMigrationMarkersTable(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_markers (
      key TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

function hasMigrationMarker(db: BunDatabase, key: string): boolean {
  return !!db.prepare(`SELECT key FROM migration_markers WHERE key = ?`).get(key);
}

function markMigration(db: BunDatabase, key: string): void {
  db.prepare(`INSERT OR IGNORE INTO migration_markers (key, applied_at) VALUES (?, ?)`).run(
    key,
    Date.now()
  );
}

function runMarkedMigration(
  db: BunDatabase,
  key: string,
  migration: () => void,
  ensureBackup: () => void
): void {
  if (hasMigrationMarker(db, key)) return;

  ensureBackup();
  migration();
  markMigration(db, key);
}

function seedHistoricalMigrationMarkers(db: BunDatabase): void {
  if (hasMigrationMarker(db, migrationMarkerKey(1))) return;

  const alreadyRanMigration155 = hasMigrationMarker(db, 'm154_legacy_long_horizon_agent_data');
  const alreadyRanMigration157 = hasMigrationMarker(
    db,
    'm157_archive_terminal_space_task_worker_sessions'
  );
  const hasBaselineSchema = hasCurrentBaselineSchema(db);
  const currentThrough =
    alreadyRanMigration157 && hasBaselineSchema ? 157 : hasBaselineSchema ? 156 : 0;

  if (currentThrough === 0) return;

  for (let version = 1; version <= currentThrough; version++) {
    if (version === 155 && !alreadyRanMigration155) continue;
    markMigration(db, migrationMarkerKey(version));
  }
  markMigration(db, 'migration_room_cleanup');
}

function hasCurrentBaselineSchema(db: BunDatabase): boolean {
  return (
    tableExists(db, 'sessions') &&
    tableHasColumn(db, 'sessions', 'acp_session_id') &&
    tableHasColumn(db, 'sessions', 'status') &&
    tableHasColumn(db, 'sessions', 'type') &&
    tableHasColumn(db, 'sessions', 'session_context') &&
    tableHasColumn(db, 'sessions', 'archived_at') &&
    tableExists(db, 'spaces') &&
    tableExists(db, 'space_agents') &&
    tableExists(db, 'space_tasks') &&
    tableHasColumn(db, 'space_tasks', 'status') &&
    tableHasColumn(db, 'space_tasks', 'task_agent_session_id') &&
    tableExists(db, 'space_workflows') &&
    tableExists(db, 'space_workflow_runs') &&
    tableHasColumn(db, 'space_workflow_runs', 'status') &&
    tableExists(db, 'node_executions') &&
    tableHasColumn(db, 'node_executions', 'workflow_run_id') &&
    tableHasColumn(db, 'node_executions', 'status') &&
    tableHasColumn(db, 'node_executions', 'completed_at') &&
    tableHasColumn(db, 'node_executions', 'updated_at') &&
    tableHasColumn(db, 'node_executions', 'created_at')
  );
}

export function runMigration94(db: BunDatabase): void {
  runMigration94External(db);
}

export function runMigration96(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflows')) {
    return;
  }
  const hasRunsTable = tableExists(db, 'space_workflow_runs');

  let stmt: string;
  if (hasRunsTable) {
    stmt = `
			DELETE FROM space_workflows
			WHERE name = 'Full-Cycle Coding Workflow'
			  AND id NOT IN (
			    SELECT DISTINCT workflow_id
			    FROM space_workflow_runs
			    WHERE status IN ('pending', 'in_progress', 'blocked')
			  )
		`;
  } else {
    stmt = `DELETE FROM space_workflows WHERE name = 'Full-Cycle Coding Workflow'`;
  }
  try {
    db.exec(stmt);
  } catch {}
}

export function runMigration97(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflows')) return;
  if (!tableHasColumn(db, 'space_workflows', 'template_name')) return;

  const BUILT_IN_NAMES = [
    'Coding Workflow',
    'Coding with QA Workflow',
    'Full-Cycle Coding Workflow',
    'Fullstack QA Loop Workflow',
    'Plan & Decompose Workflow',
    'Research Workflow',
    'Review-Only Workflow',
  ];

  const placeholders = BUILT_IN_NAMES.map(() => '?').join(', ');

  if (tableExists(db, 'space_workflow_runs')) {
    db.prepare(
      `DELETE FROM space_workflow_runs
			  WHERE workflow_id IN (
			    SELECT id FROM space_workflows
			    WHERE template_name IS NULL
			      AND name IN (${placeholders})
			  )`
    ).run(...BUILT_IN_NAMES);
  }

  db.prepare(
    `DELETE FROM space_workflows
		  WHERE template_name IS NULL
		    AND name IN (${placeholders})`
  ).run(...BUILT_IN_NAMES);
}

function runMigration1(db: BunDatabase): void {
  if (!tableExists(db, 'auth_config')) {
    return;
  }
  try {
    db.prepare(`SELECT oauth_token_encrypted FROM auth_config LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE auth_config ADD COLUMN oauth_token_encrypted TEXT`);
  }
}

function runMigration2(db: BunDatabase): void {
  try {
    db.prepare(`SELECT 1 FROM messages LIMIT 1`).all();
    db.exec(`DROP TABLE IF EXISTS tool_calls`);
    db.exec(`DROP TABLE IF EXISTS messages`);
    db.exec(`DROP INDEX IF EXISTS idx_messages_session`);
    db.exec(`DROP INDEX IF EXISTS idx_tool_calls_message`);
  } catch {}
}

function runMigration3(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) {
    return;
  }
  try {
    db.prepare(`SELECT is_worktree FROM sessions LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE sessions ADD COLUMN is_worktree INTEGER DEFAULT 0`);
    db.exec(`ALTER TABLE sessions ADD COLUMN worktree_path TEXT`);
    db.exec(`ALTER TABLE sessions ADD COLUMN main_repo_path TEXT`);
    db.exec(`ALTER TABLE sessions ADD COLUMN worktree_branch TEXT`);
  }
}

function runMigration4(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) {
    return;
  }
  try {
    db.prepare(`SELECT git_branch FROM sessions LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE sessions ADD COLUMN git_branch TEXT`);
  }
}

function runMigration5(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) {
    return;
  }
  try {
    db.prepare(`SELECT sdk_session_id FROM sessions LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT`);
  }
}

function runMigration6(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) {
    return;
  }
  try {
    db.prepare(`SELECT available_commands FROM sessions LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE sessions ADD COLUMN available_commands TEXT`);
  }
}

function runMigration7(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) {
    return;
  }
  try {
    db.prepare(`SELECT processing_state FROM sessions LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE sessions ADD COLUMN processing_state TEXT`);
  }
}

function runMigration8(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) {
    return;
  }
  try {
    db.prepare(`SELECT archived_at FROM sessions LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE sessions ADD COLUMN archived_at TEXT`);
  }
}

function runMigration9(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) {
    return;
  }
  try {
    const testId = '__migration_test_archived_status__';
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id, available_commands, processing_state, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      testId,
      'Test',
      '/tmp',
      new Date().toISOString(),
      new Date().toISOString(),
      'archived',
      '{}',
      '{}',
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null
    );
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
  } catch {
    db.exec('PRAGMA foreign_keys = OFF');

    try {
      db.exec(`
				-- Create new table with updated CHECK constraint
				CREATE TABLE sessions_new (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					workspace_path TEXT NOT NULL,
					created_at TEXT NOT NULL,
					last_active_at TEXT NOT NULL,
					status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived')),
					config TEXT NOT NULL,
					metadata TEXT NOT NULL,
					is_worktree INTEGER DEFAULT 0,
					worktree_path TEXT,
					main_repo_path TEXT,
					worktree_branch TEXT,
					git_branch TEXT,
					sdk_session_id TEXT,
					available_commands TEXT,
					processing_state TEXT,
					archived_at TEXT
				);

				-- Copy all data from old table to new table
				INSERT INTO sessions_new
				SELECT id, title, workspace_path, created_at, last_active_at, status, config, metadata,
					   is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch,
					   sdk_session_id, available_commands, processing_state, archived_at
				FROM sessions;

				-- Drop old table (safe now that foreign_keys is OFF)
				DROP TABLE sessions;

				-- Rename new table to original name
				ALTER TABLE sessions_new RENAME TO sessions;
			`);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

function runMigration10(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) {
    return;
  }
  try {
    db.prepare(`SELECT send_status FROM sdk_messages LIMIT 1`).all();
  } catch {
    db.exec(
      `ALTER TABLE sdk_messages ADD COLUMN send_status TEXT DEFAULT 'sent' CHECK(send_status IN ('saved', 'queued', 'sent'))`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status ON sdk_messages(session_id, send_status)`
    );
  }
}

function runMigration11(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) {
    return;
  }
  try {
    db.prepare(`SELECT parent_id FROM sessions LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE sessions ADD COLUMN parent_id TEXT`);
    db.exec(`ALTER TABLE sessions ADD COLUMN labels TEXT`);
    db.exec(`ALTER TABLE sessions ADD COLUMN sub_session_order INTEGER DEFAULT 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id)`);
  }
}

export function runMigration12(db: BunDatabase): void {
  if (!tableExists(db, 'global_settings')) {
    return;
  }
  try {
    const row = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as
      | { settings: string }
      | undefined;

    if (!row) {
      db.exec(`
        INSERT INTO global_settings (id, settings, updated_at)
        VALUES (1, '{"autoScroll":true}', datetime('now'))
      `);
      return;
    }

    const settings = JSON.parse(row.settings) as Record<string, unknown>;

    if (settings.autoScroll === undefined) {
      settings.autoScroll = true;
      db.exec(`
        UPDATE global_settings
        SET settings = '${JSON.stringify(settings).replace(/'/g, "''")}',
            updated_at = datetime('now')
        WHERE id = 1
      `);
    }
  } catch {}
}

function runMigration13(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) {
    return;
  }
  try {
    const testId = '__migration_test_pending_worktree_choice_status__';
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch, sdk_session_id, available_commands, processing_state, archived_at, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      testId,
      'Test',
      '/tmp',
      new Date().toISOString(),
      new Date().toISOString(),
      'pending_worktree_choice',
      '{}',
      '{}',
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null
    );
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
  } catch {
    db.exec('PRAGMA foreign_keys = OFF');

    try {
      const hasLabels = tableHasColumn(db, 'sessions', 'labels');
      const hasSubOrder = tableHasColumn(db, 'sessions', 'sub_session_order');

      db.exec(`
				-- Create new table with updated CHECK constraint
				CREATE TABLE sessions_new (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					workspace_path TEXT NOT NULL,
					created_at TEXT NOT NULL,
					last_active_at TEXT NOT NULL,
					status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
					config TEXT NOT NULL,
					metadata TEXT NOT NULL,
					is_worktree INTEGER DEFAULT 0,
					worktree_path TEXT,
					main_repo_path TEXT,
					worktree_branch TEXT,
					git_branch TEXT,
					sdk_session_id TEXT,
					available_commands TEXT,
					processing_state TEXT,
					archived_at TEXT,
					parent_id TEXT
				);

				-- Copy all data from old table to new table
				INSERT INTO sessions_new
				SELECT id, title, workspace_path, created_at, last_active_at, status, config, metadata,
					   is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch,
					   sdk_session_id, available_commands, processing_state, archived_at, parent_id
				FROM sessions;

				-- Drop old table (safe now that foreign_keys is OFF)
				DROP TABLE sessions;

				-- Rename new table to original name
				ALTER TABLE sessions_new RENAME TO sessions;
			`);

      if (hasLabels) {
        db.exec(`ALTER TABLE sessions ADD COLUMN labels TEXT`);
      }
      if (hasSubOrder) {
        db.exec(`ALTER TABLE sessions ADD COLUMN sub_session_order INTEGER DEFAULT 0`);
      }
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

function runMigration14(db: BunDatabase): void {
  db.exec(`DROP TABLE IF EXISTS events`);
  db.exec(`DROP INDEX IF EXISTS idx_events_session`);

  if (!tableExists(db, 'sessions')) return;
  if (tableHasColumn(db, 'sessions', 'labels')) {
    db.exec(`ALTER TABLE sessions DROP COLUMN labels`);
  }
  if (tableHasColumn(db, 'sessions', 'sub_session_order')) {
    db.exec(`ALTER TABLE sessions DROP COLUMN sub_session_order`);
  }
}

function runMigration15(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) {
    return;
  }
  const tableInfo = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sdk_messages'`)
    .get() as { sql: string } | null;
  if (tableInfo?.sql?.includes("'failed'")) {
    return;
  }

  db.exec(`PRAGMA foreign_keys = OFF`);
  try {
    db.exec(`
			CREATE TABLE sdk_messages_new (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT DEFAULT 'sent' CHECK(send_status IN ('saved', 'queued', 'sent', 'failed')),
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			)
		`);
    db.exec(`INSERT INTO sdk_messages_new SELECT * FROM sdk_messages`);
    db.exec(`DROP TABLE sdk_messages`);
    db.exec(`ALTER TABLE sdk_messages_new RENAME TO sdk_messages`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_id ON sdk_messages(session_id)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status ON sdk_messages(session_id, send_status)`
    );
  } finally {
    db.exec(`PRAGMA foreign_keys = ON`);
  }
}

function runMigration16(db: BunDatabase): void {
  if (tableExists(db, 'tasks')) {
    const tableInfo = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
      .get() as { sql: string } | null;
    const needsTaskMigration =
      tableInfo !== null &&
      (tableInfo.sql.includes("'escalated'") || !tableInfo.sql.includes("'review'"));

    if (needsTaskMigration) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec(`PRAGMA ignore_check_constraints = 1`);
        db.exec(`UPDATE tasks SET status = 'failed' WHERE status = 'escalated'`);
        db.exec(`PRAGMA ignore_check_constraints = 0`);

        db.exec(`DROP TABLE IF EXISTS tasks_new`);

        db.exec(`
					CREATE TABLE tasks_new (
						id TEXT PRIMARY KEY,
						room_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL,
						status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'failed', 'cancelled')),
						priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						progress INTEGER,
						current_step TEXT,
						result TEXT,
						error TEXT,
						depends_on TEXT DEFAULT '[]',
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						task_type TEXT DEFAULT 'coding' CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'goal_review')),
						assigned_agent TEXT DEFAULT 'coder',
						created_by_task_id TEXT,
						FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
					)
				`);
        const cols = [
          'id',
          'room_id',
          'title',
          'description',
          'status',
          'priority',
          'progress',
          'current_step',
          'result',
          'error',
          'depends_on',
          'created_at',
          'started_at',
          'completed_at',
        ];
        const optionalCols = ['task_type', 'assigned_agent', 'created_by_task_id'];
        for (const col of optionalCols) {
          if (tableHasColumn(db, 'tasks', col)) cols.push(col);
        }
        const selectCols = cols.join(', ');
        db.exec(`INSERT INTO tasks_new (${selectCols}) SELECT ${selectCols} FROM tasks`);
        db.exec(`DROP TABLE tasks`);
        db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  if (tableExists(db, 'session_groups')) {
    const testId = '__migration15_sg_test__';
    let needsGroupMigration = false;
    try {
      db.prepare(
        `INSERT INTO session_groups (id, group_type, ref_id, state, version, metadata, created_at)
				 VALUES (?, 'task', 'test', 'hibernated', 0, '{}', 0)`
      ).run(testId);
      db.prepare(`DELETE FROM session_groups WHERE id = ?`).run(testId);
      needsGroupMigration = true;
    } catch {}

    if (needsGroupMigration) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec(`UPDATE session_groups SET state = 'failed' WHERE state = 'hibernated'`);

        db.exec(`DROP TABLE IF EXISTS session_groups_new`);

        db.exec(`
					CREATE TABLE session_groups_new (
						id TEXT PRIMARY KEY,
						group_type TEXT NOT NULL DEFAULT 'task',
						ref_id TEXT NOT NULL,
						state TEXT NOT NULL DEFAULT 'awaiting_worker'
							CHECK(state IN ('awaiting_worker', 'awaiting_leader', 'awaiting_human', 'completed', 'failed')),
						version INTEGER NOT NULL DEFAULT 0,
						metadata TEXT NOT NULL DEFAULT '{}',
						created_at INTEGER NOT NULL,
						completed_at INTEGER
					)
				`);
        db.exec(`
					INSERT INTO session_groups_new
					SELECT id, group_type, ref_id, state, version, metadata, created_at, completed_at
					FROM session_groups
				`);
        db.exec(`DROP TABLE session_groups`);
        db.exec(`ALTER TABLE session_groups_new RENAME TO session_groups`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_session_groups_ref ON session_groups(ref_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_session_groups_state ON session_groups(state)`);
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  if (tableExists(db, 'rooms') && !tableHasColumn(db, 'rooms', 'config')) {
    db.exec(`ALTER TABLE rooms ADD COLUMN config TEXT`);
  }
}

function runMigration17(db: BunDatabase): void {
  if (!tableExists(db, 'goals')) {
    return;
  }

  const testId = '__migration16_goals_test__';
  let needsConstraintFix = false;
  try {
    db.prepare(
      `INSERT INTO goals (id, room_id, title, description, status, priority, created_at, updated_at)
			 VALUES (?, 'test', 'test', '', 'active', 'normal', 0, 0)`
    ).run(testId);
    db.prepare(`DELETE FROM goals WHERE id = ?`).run(testId);
  } catch {
    needsConstraintFix = true;
  }

  const needsColumn = !tableHasColumn(db, 'goals', 'goal_review_attempts');

  if (!needsConstraintFix && !needsColumn) {
    return;
  }

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    if (needsConstraintFix) {
      db.exec(`PRAGMA ignore_check_constraints = 1`);
      db.exec(`UPDATE goals SET status = 'active' WHERE status IN ('pending', 'in_progress')`);
      db.exec(`UPDATE goals SET status = 'needs_human' WHERE status = 'blocked'`);
      db.exec(`PRAGMA ignore_check_constraints = 0`);
    }

    db.exec(`DROP TABLE IF EXISTS goals_new`);

    const hasGoalReviewAttempts = tableHasColumn(db, 'goals', 'goal_review_attempts');
    const hasPlanningAttempts = tableHasColumn(db, 'goals', 'planning_attempts');

    db.exec(`
			CREATE TABLE goals_new (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'needs_human', 'completed', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				progress INTEGER DEFAULT 0,
				linked_task_ids TEXT DEFAULT '[]',
				metrics TEXT DEFAULT '{}',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				planning_attempts INTEGER DEFAULT 0,
				goal_review_attempts INTEGER DEFAULT 0,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			)
		`);

    const cols = [
      'id',
      'room_id',
      'title',
      'description',
      'status',
      'priority',
      'progress',
      'linked_task_ids',
      'metrics',
      'created_at',
      'updated_at',
      'completed_at',
    ];
    if (hasPlanningAttempts) {
      cols.push('planning_attempts');
    }
    if (hasGoalReviewAttempts) {
      cols.push('goal_review_attempts');
    }
    const selectCols = cols.join(', ');
    db.exec(`INSERT INTO goals_new (${selectCols}) SELECT ${selectCols} FROM goals`);

    db.exec(`DROP TABLE goals`);
    db.exec(`ALTER TABLE goals_new RENAME TO goals`);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_room ON goals(room_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function runMigration18(db: BunDatabase): void {
  if (!tableExists(db, 'tasks')) {
    return;
  }

  const tableInfo = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
    .get() as { sql: string } | null;
  const needsMigration = tableInfo !== null && !tableInfo.sql.includes("'cancelled'");

  if (!needsMigration) return;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`DROP TABLE IF EXISTS tasks_new`);

    db.exec(`
			CREATE TABLE tasks_new (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'failed', 'cancelled')),
				priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT DEFAULT '[]',
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				task_type TEXT DEFAULT 'coding' CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'goal_review')),
				assigned_agent TEXT DEFAULT 'coder',
				created_by_task_id TEXT,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			)
		`);

    const cols = [
      'id',
      'room_id',
      'title',
      'description',
      'status',
      'priority',
      'progress',
      'current_step',
      'result',
      'error',
      'depends_on',
      'created_at',
      'started_at',
      'completed_at',
    ];
    const optionalCols = ['task_type', 'assigned_agent', 'created_by_task_id'];
    for (const col of optionalCols) {
      if (tableHasColumn(db, 'tasks', col)) cols.push(col);
    }
    const selectCols = cols.join(', ');
    db.exec(`INSERT INTO tasks_new (${selectCols}) SELECT ${selectCols} FROM tasks`);
    db.exec(`DROP TABLE tasks`);
    db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
    .get(columnName);
  return !!result;
}

function tableCreateSql(db: BunDatabase, tableName: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName) as { sql?: string } | undefined;
  return row?.sql ?? null;
}

function quoteSqlIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function tableColumnNames(db: BunDatabase, tableName: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${quoteSqlString(tableName)})`).all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function replaceCreateTableName(createSql: string, newTableName: string): string {
  const replaced = createSql.replace(
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)/i,
    `CREATE TABLE ${quoteSqlIdent(newTableName)}`
  );
  if (replaced === createSql) {
    throw new Error('Unable to rewrite CREATE TABLE statement');
  }
  return replaced;
}

function widenSpaceTasksApprovedStatusCheck(createSql: string): string {
  let matched = false;
  const widened = createSql.replace(
    /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i,
    (match, values: string) => {
      matched = true;
      if (values.includes("'approved'")) {
        return match;
      }
      return `CHECK(status IN (${values.trim()}, 'approved'))`;
    }
  );
  if (!matched) {
    throw new Error('Unable to widen space_tasks.status CHECK constraint');
  }
  return widened;
}

function matchingParenIndex(sql: string, openIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | '`' | ']' | null = null;
  for (let i = openIndex; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (quote === "'" && ch === "'" && sql[i + 1] === "'") {
        i++;
        continue;
      }
      if (quote === ']' ? ch === ']' : ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      quote = ']';
      continue;
    }
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  throw new Error('Unable to find closing parenthesis in CREATE TABLE statement');
}

function splitTopLevelSqlList(sql: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | '`' | ']' | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (quote === "'" && ch === "'" && sql[i + 1] === "'") {
        i++;
        continue;
      }
      if (quote === ']' ? ch === ']' : ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      quote = ']';
      continue;
    }
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(sql.slice(start));
  return parts;
}

function createTableSqlWithoutColumn(createSql: string, columnName: string): string {
  const open = createSql.indexOf('(');
  if (open < 0) {
    throw new Error('Unable to parse CREATE TABLE statement');
  }
  const close = matchingParenIndex(createSql, open);
  const prefix = createSql.slice(0, open + 1);
  const body = createSql.slice(open + 1, close);
  const suffix = createSql.slice(close);
  const columnPattern = new RegExp(
    `^\\s*(?:"${columnName.replaceAll('"', '""')}"|\\[${columnName.replaceAll(']', ']]')}\\]|\\\`${columnName.replaceAll('`', '``')}\\\`|${columnName})\\b`,
    'i'
  );
  const parts = splitTopLevelSqlList(body).filter((part) => !columnPattern.test(part.trimStart()));
  return `${prefix}${parts.join(',')}${suffix}`;
}

function tightenPendingCheckpointTypeCheck(createSql: string): string {
  return createSql.replace(
    /CHECK\s*\(\s*pending_checkpoint_type\s+IN\s*\([^)]*\)\s*\)/i,
    "CHECK(pending_checkpoint_type IN ('gate', 'task_completion'))"
  );
}

function capturedIndexDdl(
  db: BunDatabase,
  tableName: string
): Array<{ sql: string; columns: string[] }> {
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`
    )
    .all(tableName) as Array<{ name: string; sql: string }>;
  return rows.map((row) => {
    const indexColumns = db
      .prepare(`PRAGMA index_info(${quoteSqlString(row.name)})`)
      .all() as Array<{ name: string | null }>;
    return {
      sql: row.sql,
      columns: indexColumns.map((col) => col.name).filter((name): name is string => !!name),
    };
  });
}

function recreateCompatibleIndexes(
  db: BunDatabase,
  tableName: string,
  indexes: Array<{ sql: string; columns: string[] }>
): void {
  const columns = new Set(tableColumnNames(db, tableName));
  for (const index of indexes) {
    if (index.columns.some((column) => !columns.has(column))) {
      continue;
    }
    const normalized = index.sql.replace(
      /^CREATE (UNIQUE )?INDEX /i,
      (_m, unique) => `CREATE ${unique ?? ''}INDEX IF NOT EXISTS `
    );
    try {
      db.exec(normalized);
    } catch (err) {
      if (err instanceof Error && /\bno such column\b/i.test(err.message)) {
        continue;
      }
      throw err;
    }
  }
}

function statusCheckContains(db: BunDatabase, tableName: string, status: string): boolean {
  const sql = tableCreateSql(db, tableName);
  if (!sql) return false;

  const match = sql.match(/status\s+TEXT[\s\S]*?CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i);
  return match?.[1]?.includes(`'${status}'`) ?? false;
}

function runMigration19(db: BunDatabase): void {
  db.exec(`DROP TABLE IF EXISTS session_group_messages`);
  db.exec(`DROP INDEX IF EXISTS idx_sgmsg_group`);
}

function runMigration20(db: BunDatabase): void {
  if (!tableExists(db, 'tasks')) {
    return;
  }

  if (tableHasColumn(db, 'tasks', 'archived_at')) {
    return;
  }

  db.exec(`ALTER TABLE tasks ADD COLUMN archived_at INTEGER`);
}

function runMigration21(db: BunDatabase): void {
  if (!tableExists(db, 'session_groups')) {
    return;
  }
  if (!tableHasColumn(db, 'session_groups', 'state')) {
    return;
  }

  const rows = db
    .prepare(
      `SELECT id, metadata
			 FROM session_groups
			 WHERE completed_at IS NULL AND state = 'awaiting_human'`
    )
    .all() as Array<{ id: string; metadata: string | null }>;

  const update = db.prepare(`UPDATE session_groups SET metadata = ? WHERE id = ?`);
  for (const row of rows) {
    let meta: Record<string, unknown> = {};
    if (row.metadata) {
      try {
        meta = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        meta = {};
      }
    }
    if (meta.submittedForReview === true) {
      continue;
    }
    meta.submittedForReview = true;
    update.run(JSON.stringify(meta), row.id);
  }
}

function runMigration22(db: BunDatabase): void {
  db.exec(`DROP INDEX IF EXISTS idx_session_groups_state`);

  if (!tableExists(db, 'session_groups')) {
    return;
  }
  if (!tableHasColumn(db, 'session_groups', 'state')) {
    return;
  }

  db.exec(`ALTER TABLE session_groups DROP COLUMN state`);
}

function runMigration23(db: BunDatabase): void {
  if (!tableExists(db, 'tasks')) {
    return;
  }
  if (tableHasColumn(db, 'tasks', 'active_session')) {
    return;
  }
  db.exec(`ALTER TABLE tasks ADD COLUMN active_session TEXT`);
}

function runMigration24(db: BunDatabase): void {
  if (!tableExists(db, 'tasks')) {
    return;
  }

  const tableInfo = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
    .get() as { sql: string } | null;
  const needsMigration = tableInfo !== null && tableInfo.sql.includes("'failed'");

  if (!needsMigration) return;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`DROP TABLE IF EXISTS tasks_new`);

    db.exec(`
			CREATE TABLE tasks_new (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled')),
				priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT DEFAULT '[]',
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				task_type TEXT DEFAULT 'coding' CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'goal_review')),
				assigned_agent TEXT DEFAULT 'coder',
				created_by_task_id TEXT,
				archived_at INTEGER,
				active_session TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			)
		`);

    const baseCols = [
      'id',
      'room_id',
      'title',
      'description',
      'priority',
      'progress',
      'current_step',
      'result',
      'error',
      'depends_on',
      'created_at',
      'started_at',
      'completed_at',
    ];
    const optionalCols = [
      'task_type',
      'assigned_agent',
      'created_by_task_id',
      'archived_at',
      'active_session',
      'pr_url',
      'pr_number',
      'pr_created_at',
    ];
    for (const col of optionalCols) {
      if (tableHasColumn(db, 'tasks', col)) baseCols.push(col);
    }

    const colsWithoutStatus = baseCols.join(', ');
    db.exec(`PRAGMA ignore_check_constraints = 1`);
    db.exec(`
			INSERT INTO tasks_new (status, ${colsWithoutStatus})
			SELECT
				CASE WHEN status = 'failed' THEN 'needs_attention' ELSE status END,
				${colsWithoutStatus}
			FROM tasks
		`);
    db.exec(`PRAGMA ignore_check_constraints = 0`);

    db.exec(`DROP TABLE tasks`);
    db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function runMigration25(db: BunDatabase): void {
  if (!tableExists(db, 'tasks')) {
    return;
  }
  if (!tableHasColumn(db, 'tasks', 'pr_url')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN pr_url TEXT`);
  }
  if (!tableHasColumn(db, 'tasks', 'pr_number')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN pr_number INTEGER`);
  }
  if (!tableHasColumn(db, 'tasks', 'pr_created_at')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN pr_created_at INTEGER`);
  }
}

function runMigration26(db: BunDatabase): void {
  if (!tableExists(db, 'tasks')) {
    return;
  }
  if (tableHasColumn(db, 'tasks', 'input_draft')) {
    return;
  }
  db.exec(`ALTER TABLE tasks ADD COLUMN input_draft TEXT`);
}

function runMigration27(db: BunDatabase): void {
  if (!tableExists(db, 'tasks')) {
    return;
  }
  if (!tableHasColumn(db, 'tasks', 'updated_at')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN updated_at INTEGER`);
    db.exec(
      `UPDATE tasks SET updated_at = COALESCE(completed_at, started_at, created_at) WHERE updated_at IS NULL`
    );
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room_updated ON tasks(room_id, updated_at DESC)`);
}

function runMigrationRoomCleanup(db: BunDatabase): void {
  db.exec(`PRAGMA foreign_keys = OFF`);
  try {
    db.exec(`DROP TABLE IF EXISTS neo_context_messages`);
    db.exec(`DROP TABLE IF EXISTS neo_contexts`);
    db.exec(`DROP TABLE IF EXISTS neo_tasks`);
    db.exec(`DROP TABLE IF EXISTS neo_memories`);
    db.exec(`DROP TABLE IF EXISTS neo_rooms`);
    db.exec(`DROP TABLE IF EXISTS room_agent_states`);
    db.exec(`DROP TABLE IF EXISTS worker_sessions`);
    db.exec(`DROP TABLE IF EXISTS worker_sessions_orphaned`);
    db.exec(`DROP TABLE IF EXISTS recurring_jobs`);
    db.exec(`DROP TABLE IF EXISTS room_context_versions`);
    db.exec(`DROP TABLE IF EXISTS context_messages`);
    db.exec(`DROP TABLE IF EXISTS contexts`);
    db.exec(`DROP TABLE IF EXISTS memories`);
    db.exec(`DROP TABLE IF EXISTS session_pairs`);
    db.exec(`DROP TABLE IF EXISTS task_pairs`);
    db.exec(`DROP TABLE IF EXISTS rendered_prompts`);
    db.exec(`DROP TABLE IF EXISTS prompt_templates`);

    if (!tableExists(db, 'sessions')) return;

    if (!tableHasColumn(db, 'sessions', 'type')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN type TEXT DEFAULT 'worker'`);
    }
    if (!tableHasColumn(db, 'sessions', 'session_context')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN session_context TEXT`);
    }

    const testId = '__migration_room_cleanup_test__';
    try {
      db.exec(
        `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, type)
				 VALUES ('${testId}', 'test', '/', datetime('now'), datetime('now'), 'active', '{}', '{}', 'planner')`
      );
      db.exec(`DELETE FROM sessions WHERE id = '${testId}'`);
      return;
    } catch {}

    db.exec(`PRAGMA ignore_check_constraints = 1`);
    db.exec(`UPDATE sessions SET type = 'coder' WHERE type IN ('craft', 'room_self')`);
    db.exec(`UPDATE sessions SET type = 'leader' WHERE type IN ('lead', 'manager')`);
    db.exec(`PRAGMA ignore_check_constraints = 0`);
    db.exec(
      `DELETE FROM sessions WHERE type NOT IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby')`
    );

    db.exec(`
			CREATE TABLE sessions_new (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				workspace_path TEXT NOT NULL,
				created_at TEXT NOT NULL,
				last_active_at TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
				config TEXT NOT NULL,
				metadata TEXT NOT NULL,
				is_worktree INTEGER DEFAULT 0,
				worktree_path TEXT,
				main_repo_path TEXT,
				worktree_branch TEXT,
				git_branch TEXT,
				sdk_session_id TEXT,
				available_commands TEXT,
				processing_state TEXT,
				archived_at TEXT,
				parent_id TEXT,
				type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby')),
				session_context TEXT
			)
		`);
    db.exec(`
			INSERT INTO sessions_new
			SELECT id, title, workspace_path, created_at, last_active_at,
				status, config, metadata, is_worktree, worktree_path, main_repo_path,
				worktree_branch, git_branch, sdk_session_id, available_commands,
				processing_state, archived_at, parent_id, type, session_context
			FROM sessions
		`);
    db.exec(`DROP TABLE sessions`);
    db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
  } finally {
    db.exec(`PRAGMA foreign_keys = ON`);
  }
}

function runMigration28(db: BunDatabase): void {
  if (tableExists(db, 'goals')) {
    if (!tableHasColumn(db, 'goals', 'mission_type')) {
      db.exec(
        `ALTER TABLE goals ADD COLUMN mission_type TEXT NOT NULL DEFAULT 'one_shot'` +
          ` CHECK(mission_type IN ('one_shot', 'measurable', 'recurring'))`
      );
      db.exec(`UPDATE goals SET mission_type = 'one_shot' WHERE mission_type IS NULL`);
    }
    if (!tableHasColumn(db, 'goals', 'autonomy_level')) {
      db.exec(
        `ALTER TABLE goals ADD COLUMN autonomy_level TEXT NOT NULL DEFAULT 'supervised'` +
          ` CHECK(autonomy_level IN ('supervised', 'semi_autonomous'))`
      );
      db.exec(`UPDATE goals SET autonomy_level = 'supervised' WHERE autonomy_level IS NULL`);
    }
    if (!tableHasColumn(db, 'goals', 'schedule')) {
      db.exec(`ALTER TABLE goals ADD COLUMN schedule TEXT`);
    }
    if (!tableHasColumn(db, 'goals', 'schedule_paused')) {
      db.exec(`ALTER TABLE goals ADD COLUMN schedule_paused INTEGER NOT NULL DEFAULT 0`);
    }
    if (!tableHasColumn(db, 'goals', 'next_run_at')) {
      db.exec(`ALTER TABLE goals ADD COLUMN next_run_at INTEGER`);
    }
    if (!tableHasColumn(db, 'goals', 'structured_metrics')) {
      db.exec(`ALTER TABLE goals ADD COLUMN structured_metrics TEXT`);
    }
    if (!tableHasColumn(db, 'goals', 'max_consecutive_failures')) {
      db.exec(`ALTER TABLE goals ADD COLUMN max_consecutive_failures INTEGER NOT NULL DEFAULT 3`);
    }
    if (!tableHasColumn(db, 'goals', 'max_planning_attempts')) {
      db.exec(`ALTER TABLE goals ADD COLUMN max_planning_attempts INTEGER NOT NULL DEFAULT 0`);
    } else {
      db.exec(`UPDATE goals SET max_planning_attempts = 0 WHERE max_planning_attempts = 5`);
    }
    if (!tableHasColumn(db, 'goals', 'consecutive_failures')) {
      db.exec(`ALTER TABLE goals ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`);
    }
    if (!tableHasColumn(db, 'goals', 'replan_count')) {
      db.exec(`ALTER TABLE goals ADD COLUMN replan_count INTEGER NOT NULL DEFAULT 0`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_goals_mission_scheduler` +
        ` ON goals(mission_type, schedule_paused, next_run_at)`
    );
  }

  db.exec(`
		CREATE TABLE IF NOT EXISTS mission_metric_history (
			id TEXT PRIMARY KEY,
			goal_id TEXT NOT NULL,
			metric_name TEXT NOT NULL,
			value REAL NOT NULL,
			recorded_at INTEGER NOT NULL,
			FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_mission_metric_history_lookup` +
      ` ON mission_metric_history(goal_id, metric_name, recorded_at)`
  );

  db.exec(`
		CREATE TABLE IF NOT EXISTS mission_executions (
			id TEXT PRIMARY KEY,
			goal_id TEXT NOT NULL,
			execution_number INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			status TEXT NOT NULL DEFAULT 'running',
			result_summary TEXT,
			task_ids TEXT NOT NULL DEFAULT '[]',
			planning_attempts INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
			UNIQUE(goal_id, execution_number)
		)
	`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_executions_one_running` +
      ` ON mission_executions(goal_id) WHERE status = 'running'`
  );
}

function runMigration29(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS spaces (
			id TEXT PRIMARY KEY,
			workspace_path TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			background_context TEXT NOT NULL DEFAULT '',
			instructions TEXT NOT NULL DEFAULT '',
			default_model TEXT,
			allowed_models TEXT NOT NULL DEFAULT '[]',
			session_ids TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'archived')),
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status)`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_agents (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			handle TEXT,
			description TEXT NOT NULL DEFAULT '',
			model TEXT,
			tools TEXT NOT NULL DEFAULT '[]',
			system_prompt TEXT NOT NULL DEFAULT '',
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			role TEXT NOT NULL DEFAULT '',
			provider TEXT,
			inject_workflow_context INTEGER NOT NULL DEFAULT 0,
			instructions TEXT,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_agents_space_id ON space_agents(space_id)`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflows (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			start_step_id TEXT,
			config TEXT,
			disabled INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_workflows_space_id ON space_workflows(space_id)`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_steps (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			agent_id TEXT,
			order_index INTEGER NOT NULL,
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_workflow_steps_workflow_id ON space_workflow_steps(workflow_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_workflow_steps_order ON space_workflow_steps(workflow_id, order_index)`
  );

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_definition_versions (
			workflow_id TEXT NOT NULL,
			version_hash TEXT NOT NULL,
			space_id TEXT NOT NULL,
			payload TEXT NOT NULL,
			source TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (workflow_id, version_hash),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_space_workflow_definition_versions_space
		ON space_workflow_definition_versions(space_id)
	`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_transitions (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			from_step_id TEXT NOT NULL,
			to_step_id TEXT NOT NULL,
			condition TEXT,
			order_index INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
			FOREIGN KEY (from_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE,
			FOREIGN KEY (to_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_workflow_transitions_workflow_id ON space_workflow_transitions(workflow_id)`
  );
  if (tableHasColumn(db, 'space_workflow_transitions', 'from_step_id')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_workflow_transitions_from_step ON space_workflow_transitions(workflow_id, from_step_id)`
    );
  }

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_workflow_runs (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			workflow_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			current_step_index INTEGER NOT NULL DEFAULT 0,
			current_step_id TEXT,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_space_id ON space_workflow_runs(space_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_workflow_id ON space_workflow_runs(workflow_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_status ON space_workflow_runs(status)`
  );

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_tasks (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			task_type TEXT
				CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
			assigned_agent TEXT
				CHECK(assigned_agent IN ('coder', 'general')),
			custom_agent_id TEXT,
			workflow_run_id TEXT,
			workflow_step_id TEXT,
			created_by_task_id TEXT,
			progress INTEGER,
			current_step TEXT,
			result TEXT,
			error TEXT,
			depends_on TEXT NOT NULL DEFAULT '[]',
			input_draft TEXT,
			active_session TEXT
				CHECK(active_session IN ('worker', 'leader')),
			task_agent_session_id TEXT,
			pr_url TEXT,
			pr_number INTEGER,
			pr_created_at INTEGER,
			archived_at INTEGER,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
			FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
  );
  if (!tableHasColumn(db, 'space_tasks', 'custom_agent_id')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN custom_agent_id TEXT`);
  }
  if (tableHasColumn(db, 'space_tasks', 'custom_agent_id')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
    );
  }
  if (tableHasColumn(db, 'space_tasks', 'workflow_step_id')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_step_id ON space_tasks(workflow_step_id)`
    );
  }

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_session_groups (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT,
			workflow_run_id TEXT,
			current_step_id TEXT,
			task_id TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_session_groups_space_id ON space_session_groups(space_id)`
  );

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_session_group_members (
			id TEXT PRIMARY KEY,
			group_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			role TEXT NOT NULL,
			agent_id TEXT,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'completed', 'failed')),
			order_index INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (group_id) REFERENCES space_session_groups(id) ON DELETE CASCADE,
			UNIQUE(group_id, session_id)
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_session_group_members_group_id ON space_session_group_members(group_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_session_group_members_session_id ON space_session_group_members(session_id)`
  );

  const spaceAgentsHaveCustomPrompt = tableHasColumn(db, 'space_agents', 'custom_prompt');
  if (!spaceAgentsHaveCustomPrompt) {
    try {
      db.prepare(`SELECT role FROM space_agents LIMIT 1`).all();
    } catch {
      db.exec(`ALTER TABLE space_agents ADD COLUMN role TEXT NOT NULL DEFAULT 'coder'`);
    }
  }

  try {
    db.prepare(`SELECT provider FROM space_agents LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE space_agents ADD COLUMN provider TEXT`);
  }

  if (!spaceAgentsHaveCustomPrompt) {
    try {
      db.prepare(`SELECT inject_workflow_context FROM space_agents LIMIT 1`).all();
    } catch {
      db.exec(
        `ALTER TABLE space_agents ADD COLUMN inject_workflow_context INTEGER NOT NULL DEFAULT 0`
      );
    }
  }

  try {
    db.prepare(`SELECT start_step_id FROM space_workflows LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE space_workflows ADD COLUMN start_step_id TEXT`);
  }

  try {
    db.prepare(`SELECT current_step_id FROM space_workflow_runs LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE space_workflow_runs ADD COLUMN current_step_id TEXT`);
  }

  const agentSchema = db
    .prepare<{ sql: string }, []>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='space_agents'`
    )
    .get();
  if (agentSchema?.sql.includes('CHECK(role IN')) {
    db.transaction(() => {
      db.exec(`
				CREATE TABLE space_agents_new (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					model TEXT,
					tools TEXT NOT NULL DEFAULT '[]',
					system_prompt TEXT NOT NULL DEFAULT '',
					config TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					role TEXT NOT NULL DEFAULT 'coder',
					provider TEXT,
					inject_workflow_context INTEGER NOT NULL DEFAULT 0,
					FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
				)
			`);

      db.exec(`
				INSERT INTO space_agents_new
					(id, space_id, name, description, model, tools, system_prompt, config,
					 created_at, updated_at, role, provider, inject_workflow_context)
				SELECT
					id, space_id, name, description, model, tools, system_prompt, config,
					created_at, updated_at, role, provider,
					COALESCE(inject_workflow_context, 0)
				FROM space_agents
			`);

      db.exec(`DROP TABLE space_agents`);
      db.exec(`ALTER TABLE space_agents_new RENAME TO space_agents`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_space_agents_space_id ON space_agents(space_id)`);
    })();
  }

  if (tableExists(db, 'sessions')) {
    try {
      const testId = '__migration_test_spaces_global_type__';
      db.prepare(
        `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        testId,
        'Test',
        '/tmp',
        new Date().toISOString(),
        new Date().toISOString(),
        'active',
        '{}',
        '{}',
        0,
        'spaces_global'
      );
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
    } catch {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec(`
					CREATE TABLE sessions_new (
						id TEXT PRIMARY KEY,
						title TEXT NOT NULL,
						workspace_path TEXT NOT NULL,
						created_at TEXT NOT NULL,
						last_active_at TEXT NOT NULL,
						status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
						config TEXT NOT NULL,
						metadata TEXT NOT NULL,
						is_worktree INTEGER DEFAULT 0,
						worktree_path TEXT,
						main_repo_path TEXT,
						worktree_branch TEXT,
						git_branch TEXT,
						sdk_session_id TEXT,
						available_commands TEXT,
						processing_state TEXT,
						archived_at TEXT,
						parent_id TEXT,
						type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global')),
						session_context TEXT
					)
				`);
        db.exec(`
					INSERT INTO sessions_new
					SELECT id, title, workspace_path, created_at, last_active_at,
						status, config, metadata, is_worktree, worktree_path, main_repo_path,
						worktree_branch, git_branch, sdk_session_id, available_commands,
						processing_state, archived_at, parent_id, type, session_context
					FROM sessions
				`);
        db.exec(`DROP TABLE sessions`);
        db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }
}

function runMigration30(db: BunDatabase): void {
  try {
    db.prepare(`SELECT layout FROM space_workflows LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE space_workflows ADD COLUMN layout TEXT`);
  }
}

function runMigration31(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) return;

  try {
    const testId = '__migration_test_space_task_agent_type__';
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      testId,
      'Test',
      '/tmp',
      new Date().toISOString(),
      new Date().toISOString(),
      'active',
      '{}',
      '{}',
      0,
      'space_task_agent'
    );
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
  } catch {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec(`
				CREATE TABLE sessions_new (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					workspace_path TEXT NOT NULL,
					created_at TEXT NOT NULL,
					last_active_at TEXT NOT NULL,
					status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
					config TEXT NOT NULL,
					metadata TEXT NOT NULL,
					is_worktree INTEGER DEFAULT 0,
					worktree_path TEXT,
					main_repo_path TEXT,
					worktree_branch TEXT,
					git_branch TEXT,
					sdk_session_id TEXT,
					available_commands TEXT,
					processing_state TEXT,
					archived_at TEXT,
					parent_id TEXT,
					type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global', 'space_task_agent')),
					session_context TEXT
				)
			`);
      db.exec(`
				INSERT INTO sessions_new
				SELECT id, title, workspace_path, created_at, last_active_at,
					status, config, metadata, is_worktree, worktree_path, main_repo_path,
					worktree_branch, git_branch, sdk_session_id, available_commands,
					processing_state, archived_at, parent_id, type, session_context
				FROM sessions
			`);
      db.exec(`DROP TABLE sessions`);
      db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

function runMigration32(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;
  try {
    db.prepare(`SELECT task_agent_session_id FROM space_tasks LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN task_agent_session_id TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
  );
}

function runMigration33(db: BunDatabase): void {
  if (!tableExists(db, 'spaces')) return;
  try {
    db.prepare(`SELECT autonomy_level FROM spaces LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE spaces ADD COLUMN autonomy_level TEXT NOT NULL DEFAULT 'supervised'`);
  }
}

function runMigration34(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;
  try {
    db.prepare(`SELECT goal_id FROM space_tasks LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN goal_id TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
}

function runMigration35(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflow_runs')) return;
  try {
    db.prepare(`SELECT iteration_count FROM space_workflow_runs LIMIT 1`).all();
  } catch {
    db.exec(
      `ALTER TABLE space_workflow_runs ADD COLUMN iteration_count INTEGER NOT NULL DEFAULT 0`
    );
  }
  try {
    db.prepare(`SELECT max_iterations FROM space_workflow_runs LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE space_workflow_runs ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 5`);
  }
}

function runMigration36(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflows')) return;
  try {
    db.prepare(`SELECT max_iterations FROM space_workflows LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE space_workflows ADD COLUMN max_iterations INTEGER`);
  }
}

function runMigration37(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflow_runs')) return;
  try {
    db.prepare(`SELECT goal_id FROM space_workflow_runs LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE space_workflow_runs ADD COLUMN goal_id TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_goal_id ON space_workflow_runs(goal_id)`
  );
}

function runMigration38(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflow_transitions')) return;
  try {
    db.prepare(`SELECT is_cyclic FROM space_workflow_transitions LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE space_workflow_transitions ADD COLUMN is_cyclic INTEGER`);
  }
}

function runMigration39(db: BunDatabase): void {
  if (tableExists(db, 'tasks')) {
    const tableInfo = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`)
      .get() as { sql: string } | null;
    const needsMigration = tableInfo !== null && !tableInfo.sql.includes("'archived'");

    if (needsMigration) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec(`DROP TABLE IF EXISTS tasks_new`);
        db.exec(`
					CREATE TABLE tasks_new (
						id TEXT PRIMARY KEY,
						room_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL,
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
						priority TEXT NOT NULL DEFAULT 'normal'
							CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						progress INTEGER,
						current_step TEXT,
						result TEXT,
						error TEXT,
						depends_on TEXT DEFAULT '[]',
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						task_type TEXT DEFAULT 'coding'
							CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'goal_review')),
						assigned_agent TEXT DEFAULT 'coder',
						created_by_task_id TEXT,
						archived_at INTEGER,
						active_session TEXT,
						pr_url TEXT,
						pr_number INTEGER,
						pr_created_at INTEGER,
						input_draft TEXT,
						updated_at INTEGER,
						FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
					)
				`);

        const cols = [
          'id',
          'room_id',
          'title',
          'description',
          'status',
          'priority',
          'progress',
          'current_step',
          'result',
          'error',
          'depends_on',
          'created_at',
          'started_at',
          'completed_at',
        ];
        const optionalCols = [
          'task_type',
          'assigned_agent',
          'created_by_task_id',
          'archived_at',
          'active_session',
          'pr_url',
          'pr_number',
          'pr_created_at',
          'input_draft',
          'updated_at',
        ];
        for (const col of optionalCols) {
          if (tableHasColumn(db, 'tasks', col)) cols.push(col);
        }
        const selectCols = cols.join(', ');
        db.exec(`INSERT INTO tasks_new (${selectCols}) SELECT ${selectCols} FROM tasks`);
        db.exec(`DROP TABLE tasks`);
        db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_tasks_room_updated ON tasks(room_id, updated_at DESC)`
        );
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }

    db.exec(
      `UPDATE tasks SET status = 'archived' WHERE archived_at IS NOT NULL AND status != 'archived'`
    );
  }

  if (tableExists(db, 'space_tasks')) {
    const tableInfo = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
      .get() as { sql: string } | null;
    const needsMigration = tableInfo !== null && !tableInfo.sql.includes("'archived'");

    if (needsMigration) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec(`DROP TABLE IF EXISTS space_tasks_new`);
        db.exec(`
					CREATE TABLE space_tasks_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
						priority TEXT NOT NULL DEFAULT 'normal'
							CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						task_type TEXT
							CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
						assigned_agent TEXT
							CHECK(assigned_agent IN ('coder', 'general')),
						custom_agent_id TEXT,
						workflow_run_id TEXT,
						workflow_step_id TEXT,
						created_by_task_id TEXT,
						goal_id TEXT,
						progress INTEGER,
						current_step TEXT,
						result TEXT,
						error TEXT,
						depends_on TEXT NOT NULL DEFAULT '[]',
						input_draft TEXT,
						active_session TEXT
							CHECK(active_session IN ('worker', 'leader')),
						task_agent_session_id TEXT,
						pr_url TEXT,
						pr_number INTEGER,
						pr_created_at INTEGER,
						archived_at INTEGER,
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
						FOREIGN KEY (workflow_step_id) REFERENCES space_workflow_steps(id) ON DELETE SET NULL
					)
				`);

        const cols = ['id', 'space_id', 'title', 'description', 'status', 'priority'];
        const optionalCols = [
          'task_type',
          'assigned_agent',
          'custom_agent_id',
          'workflow_run_id',
          'workflow_step_id',
          'created_by_task_id',
          'goal_id',
          'progress',
          'current_step',
          'result',
          'error',
          'depends_on',
          'input_draft',
          'active_session',
          'task_agent_session_id',
          'pr_url',
          'pr_number',
          'pr_created_at',
          'archived_at',
          'created_at',
          'started_at',
          'completed_at',
          'updated_at',
        ];
        for (const col of optionalCols) {
          if (tableHasColumn(db, 'space_tasks', col)) cols.push(col);
        }
        const selectCols = cols.join(', ');
        db.exec(
          `INSERT INTO space_tasks_new (${selectCols}) SELECT ${selectCols} FROM space_tasks`
        );
        db.exec(`DROP TABLE space_tasks`);
        db.exec(`ALTER TABLE space_tasks_new RENAME TO space_tasks`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_step_id ON space_tasks(workflow_step_id)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
        );
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }

    db.exec(
      `UPDATE space_tasks SET status = 'archived' WHERE archived_at IS NOT NULL AND status != 'archived'`
    );
  }
}

function runMigration40(db: BunDatabase): void {
  if (tableExists(db, 'space_session_groups')) {
    if (!tableHasColumn(db, 'space_session_groups', 'task_id')) {
      db.exec(`ALTER TABLE space_session_groups ADD COLUMN task_id TEXT`);
    }
    if (!tableHasColumn(db, 'space_session_groups', 'status')) {
      db.exec(
        `ALTER TABLE space_session_groups ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed'))`
      );
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_session_groups_task_id ON space_session_groups(task_id)`
    );
  }

  if (
    tableExists(db, 'space_session_group_members') &&
    !tableHasColumn(db, 'space_session_group_members', 'agent_id')
  ) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec(`DROP TABLE IF EXISTS space_session_group_members_new`);
      db.exec(`
				CREATE TABLE space_session_group_members_new (
					id TEXT PRIMARY KEY,
					group_id TEXT NOT NULL,
					session_id TEXT NOT NULL,
					role TEXT NOT NULL,
					agent_id TEXT,
					status TEXT NOT NULL DEFAULT 'active'
						CHECK(status IN ('active', 'completed', 'failed')),
					order_index INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					FOREIGN KEY (group_id) REFERENCES space_session_groups(id) ON DELETE CASCADE,
					UNIQUE(group_id, session_id)
				)
			`);

      const cols = ['id', 'group_id', 'session_id', 'role', 'order_index', 'created_at'];
      const selectCols = cols.join(', ');
      db.exec(
        `INSERT INTO space_session_group_members_new (${selectCols}) SELECT ${selectCols} FROM space_session_group_members`
      );
      db.exec(`DROP TABLE space_session_group_members`);
      db.exec(`ALTER TABLE space_session_group_members_new RENAME TO space_session_group_members`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_session_group_members_group_id ON space_session_group_members(group_id)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_session_group_members_session_id ON space_session_group_members(session_id)`
      );
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

function runMigration41(_db: BunDatabase): void {}

function runMigration42(db: BunDatabase): void {
  if (!tableExists(db, 'session_groups') || !tableExists(db, 'tasks')) {
    return;
  }

  const now = Date.now();

  db.prepare(
    `UPDATE session_groups
		 SET completed_at = ?, version = version + 1
		 WHERE completed_at IS NULL
		   AND group_type IN ('task', 'task_pair')
		   AND ref_id IN (
		     SELECT id FROM tasks
		     WHERE status IN ('completed', 'cancelled', 'archived', 'needs_attention')
		   )`
  ).run(now);

  const duplicateTasks = db
    .prepare(
      `SELECT ref_id, MAX(rowid) AS max_rowid
			 FROM session_groups
			 WHERE completed_at IS NULL AND group_type IN ('task', 'task_pair')
			 GROUP BY ref_id
			 HAVING COUNT(*) > 1`
    )
    .all() as { ref_id: string; max_rowid: number }[];

  for (const { ref_id, max_rowid } of duplicateTasks) {
    db.prepare(
      `UPDATE session_groups
			 SET completed_at = ?, version = version + 1
			 WHERE ref_id = ? AND completed_at IS NULL AND rowid < ?`
    ).run(now, ref_id, max_rowid);
  }

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_groups_active_ref
		 ON session_groups(ref_id) WHERE completed_at IS NULL AND (group_type = 'task' OR group_type = 'task_pair')`
  );
}

function runMigration43(db: BunDatabase): void {
  db.exec(`DROP INDEX IF EXISTS idx_sgm_group`);
  db.exec(`DROP TABLE IF EXISTS session_group_messages`);
}

function runMigration44(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) {
    return;
  }

  const tableInfo = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sdk_messages'`)
    .get() as { sql: string } | null;

  if (!tableInfo) {
    return;
  }

  if (tableInfo.sql.includes("'deferred'") && tableInfo.sql.includes("'consumed'")) {
    return;
  }

  db.exec(`PRAGMA foreign_keys = OFF`);
  try {
    db.exec(`PRAGMA ignore_check_constraints = 1`);
    db.exec(`
			UPDATE sdk_messages
			SET send_status = CASE
				WHEN send_status = 'saved' THEN 'deferred'
				WHEN send_status = 'queued' THEN 'enqueued'
				WHEN send_status = 'sent' THEN 'consumed'
				WHEN send_status IS NULL THEN 'consumed'
				ELSE send_status
			END
		`);
    db.exec(`PRAGMA ignore_check_constraints = 0`);

    db.exec(`
			CREATE TABLE sdk_messages_new (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT DEFAULT 'consumed' CHECK(send_status IN ('deferred', 'enqueued', 'consumed', 'failed')),
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			)
		`);
    db.exec(`INSERT INTO sdk_messages_new SELECT * FROM sdk_messages`);
    db.exec(`DROP TABLE sdk_messages`);
    db.exec(`ALTER TABLE sdk_messages_new RENAME TO sdk_messages`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_id ON sdk_messages(session_id)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status ON sdk_messages(session_id, send_status)`
    );
  } finally {
    db.exec(`PRAGMA foreign_keys = ON`);
  }
}

function runMigration45(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflow_steps') || tableExists(db, 'space_workflow_nodes')) {
    return;
  }

  db.exec(`PRAGMA foreign_keys = OFF`);
  db.exec(`BEGIN`);
  try {
    db.exec(`DROP TABLE IF EXISTS space_workflow_nodes_new`);
    db.exec(`
				CREATE TABLE space_workflow_nodes_new (
					id TEXT PRIMARY KEY,
					workflow_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					agent_id TEXT,
					order_index INTEGER NOT NULL,
					config TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
				)
			`);
    db.exec(`
				INSERT INTO space_workflow_nodes_new
				SELECT id, workflow_id, name, description, agent_id, order_index, config, created_at, updated_at
				FROM space_workflow_steps
			`);
    db.exec(`DROP TABLE space_workflow_steps`);
    db.exec(`ALTER TABLE space_workflow_nodes_new RENAME TO space_workflow_nodes`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_workflow_nodes_workflow_id ON space_workflow_nodes(workflow_id)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_workflow_nodes_order ON space_workflow_nodes(workflow_id, order_index)`
    );

    if (tableHasColumn(db, 'space_workflows', 'start_step_id')) {
      db.exec(`DROP TABLE IF EXISTS space_workflows_new`);
      db.exec(`
					CREATE TABLE space_workflows_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						name TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						start_node_id TEXT,
						config TEXT,
						layout TEXT,
						max_iterations INTEGER,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
					)
				`);
      db.exec(`
					INSERT INTO space_workflows_new
					SELECT id, space_id, name, description, start_step_id, config, layout, max_iterations, created_at, updated_at
					FROM space_workflows
				`);
      db.exec(`DROP TABLE space_workflows`);
      db.exec(`ALTER TABLE space_workflows_new RENAME TO space_workflows`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_workflows_space_id ON space_workflows(space_id)`
      );
    }

    if (tableHasColumn(db, 'space_workflow_transitions', 'from_step_id')) {
      db.exec(`DROP TABLE IF EXISTS space_workflow_transitions_new`);
      db.exec(`
					CREATE TABLE space_workflow_transitions_new (
						id TEXT PRIMARY KEY,
						workflow_id TEXT NOT NULL,
						from_node_id TEXT NOT NULL,
						to_node_id TEXT NOT NULL,
						condition TEXT,
						order_index INTEGER NOT NULL DEFAULT 0,
						is_cyclic INTEGER,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
						FOREIGN KEY (from_node_id) REFERENCES space_workflow_nodes(id) ON DELETE CASCADE,
						FOREIGN KEY (to_node_id) REFERENCES space_workflow_nodes(id) ON DELETE CASCADE
					)
				`);
      db.exec(`
					INSERT INTO space_workflow_transitions_new
					SELECT id, workflow_id, from_step_id, to_step_id, condition, order_index, is_cyclic, created_at, updated_at
					FROM space_workflow_transitions
				`);
      db.exec(`DROP TABLE space_workflow_transitions`);
      db.exec(`ALTER TABLE space_workflow_transitions_new RENAME TO space_workflow_transitions`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_workflow_transitions_workflow_id ON space_workflow_transitions(workflow_id)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_workflow_transitions_from_node ON space_workflow_transitions(workflow_id, from_node_id)`
      );
    }

    if (tableHasColumn(db, 'space_workflow_runs', 'current_step_id')) {
      db.exec(`DROP TABLE IF EXISTS space_workflow_runs_new`);
      db.exec(`
					CREATE TABLE space_workflow_runs_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						workflow_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						current_step_index INTEGER NOT NULL DEFAULT 0,
						current_node_id TEXT,
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
						config TEXT,
						iteration_count INTEGER NOT NULL DEFAULT 0,
						max_iterations INTEGER NOT NULL DEFAULT 5,
						goal_id TEXT,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						completed_at INTEGER,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
					)
				`);
      db.exec(`
					INSERT INTO space_workflow_runs_new
					SELECT id, space_id, workflow_id, title, description, current_step_index, current_step_id, status, config, iteration_count, max_iterations, goal_id, created_at, updated_at, completed_at
					FROM space_workflow_runs
				`);
      db.exec(`DROP TABLE space_workflow_runs`);
      db.exec(`ALTER TABLE space_workflow_runs_new RENAME TO space_workflow_runs`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_space_id ON space_workflow_runs(space_id)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_workflow_id ON space_workflow_runs(workflow_id)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_status ON space_workflow_runs(status)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_goal_id ON space_workflow_runs(goal_id)`
      );
    }

    if (tableHasColumn(db, 'space_tasks', 'workflow_step_id')) {
      db.exec(`DROP TABLE IF EXISTS space_tasks_new`);
      db.exec(`
					CREATE TABLE space_tasks_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
						priority TEXT NOT NULL DEFAULT 'normal'
							CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						task_type TEXT
							CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
						assigned_agent TEXT
							CHECK(assigned_agent IN ('coder', 'general')),
						custom_agent_id TEXT,
						workflow_run_id TEXT,
						workflow_node_id TEXT,
						created_by_task_id TEXT,
						goal_id TEXT,
						progress INTEGER,
						current_step TEXT,
						result TEXT,
						error TEXT,
						depends_on TEXT NOT NULL DEFAULT '[]',
						input_draft TEXT,
						active_session TEXT
							CHECK(active_session IN ('worker', 'leader')),
						task_agent_session_id TEXT,
						pr_url TEXT,
						pr_number INTEGER,
						pr_created_at INTEGER,
						archived_at INTEGER,
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
						FOREIGN KEY (workflow_node_id) REFERENCES space_workflow_nodes(id) ON DELETE SET NULL
					)
				`);
      db.exec(`
					INSERT INTO space_tasks_new
					SELECT id, space_id, title, description, status, priority, task_type, assigned_agent,
								 custom_agent_id, workflow_run_id, workflow_step_id, created_by_task_id, goal_id,
								 progress, current_step, result, error, depends_on, input_draft, active_session,
								 task_agent_session_id, pr_url, pr_number, pr_created_at, archived_at,
								 created_at, started_at, completed_at, updated_at
					FROM space_tasks
				`);
      db.exec(`DROP TABLE space_tasks`);
      db.exec(`ALTER TABLE space_tasks_new RENAME TO space_tasks`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_node_id ON space_tasks(workflow_node_id)`
      );
      db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
      );
    }

    if (tableHasColumn(db, 'space_session_groups', 'current_step_id')) {
      db.exec(`DROP TABLE IF EXISTS space_session_groups_new`);
      db.exec(`
					CREATE TABLE space_session_groups_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						name TEXT NOT NULL,
						description TEXT,
						workflow_run_id TEXT,
						current_node_id TEXT,
						task_id TEXT,
						status TEXT NOT NULL DEFAULT 'active'
							CHECK(status IN ('active', 'completed', 'failed')),
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
					)
				`);
      db.exec(`
					INSERT INTO space_session_groups_new
					SELECT id, space_id, name, description, workflow_run_id, current_step_id, task_id, status, created_at, updated_at
					FROM space_session_groups
				`);
      db.exec(`DROP TABLE space_session_groups`);
      db.exec(`ALTER TABLE space_session_groups_new RENAME TO space_session_groups`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_session_groups_space_id ON space_session_groups(space_id)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_session_groups_task_id ON space_session_groups(task_id)`
      );
    }

    db.exec(`COMMIT`);
  } catch (e) {
    db.exec(`ROLLBACK`);
    throw e;
  } finally {
    db.exec(`PRAGMA foreign_keys = ON`);
  }
}

function runMigration46(db: BunDatabase): void {
  if (!tableHasColumn(db, 'space_tasks', 'slot_role')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN slot_role TEXT`);
  }
}

export function runMigration47(db: BunDatabase): void {
  if (tableExists(db, 'tasks') && !tableHasColumn(db, 'tasks', 'short_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN short_id TEXT`);
  }
  if (tableExists(db, 'goals') && !tableHasColumn(db, 'goals', 'short_id')) {
    db.exec(`ALTER TABLE goals ADD COLUMN short_id TEXT`);
  }

  if (tableExists(db, 'tasks')) {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_room_short_id ON tasks(room_id, short_id) WHERE short_id IS NOT NULL`
    );
  }
  if (tableExists(db, 'goals')) {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_room_short_id ON goals(room_id, short_id) WHERE short_id IS NOT NULL`
    );
  }

  db.exec(`
		CREATE TABLE IF NOT EXISTS short_id_counters (
			entity_type TEXT NOT NULL,
			scope_id    TEXT NOT NULL,
			counter     INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (entity_type, scope_id)
		)
	`);
}

export function runMigration48(db: BunDatabase): void {
  if (tableExists(db, 'tasks')) {
    db.exec(`DROP INDEX IF EXISTS idx_tasks_short_id`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_room_short_id ON tasks(room_id, short_id) WHERE short_id IS NOT NULL`
    );
  }
  if (tableExists(db, 'goals')) {
    db.exec(`DROP INDEX IF EXISTS idx_goals_short_id`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_room_short_id ON goals(room_id, short_id) WHERE short_id IS NOT NULL`
    );
  }
}

export function runMigration49(db: BunDatabase): void {
  if (!tableExists(db, 'tasks')) return;

  if (!tableHasColumn(db, 'tasks', 'restrictions')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN restrictions TEXT`);
  }

  const schemaSql = (
    db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`).get() as
      | { sql: string }
      | undefined
  )?.sql;

  if (schemaSql && schemaSql.includes('rate_limited')) {
    return;
  }

  db.exec(`DROP TABLE IF EXISTS tasks_migration49_new`);
  db.exec(`
		CREATE TABLE tasks_migration49_new (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('draft','pending','in_progress','review','completed','needs_attention','cancelled','archived','rate_limited','usage_limited')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low','normal','high','urgent')),
			progress INTEGER,
			current_step TEXT,
			result TEXT,
			error TEXT,
			depends_on TEXT DEFAULT '[]',
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			task_type TEXT DEFAULT 'coding'
				CHECK(task_type IN ('planning','coding','research','design','goal_review')),
			assigned_agent TEXT DEFAULT 'coder',
			created_by_task_id TEXT,
			archived_at INTEGER,
			active_session TEXT,
			pr_url TEXT,
			pr_number INTEGER,
			pr_created_at INTEGER,
			input_draft TEXT,
			updated_at INTEGER,
			short_id TEXT,
			restrictions TEXT,
			FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
		)
	`);
  const oldColumns = new Set(
    (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((r) => r.name)
  );
  const allNewColumns = [
    'id',
    'room_id',
    'title',
    'description',
    'status',
    'priority',
    'progress',
    'current_step',
    'result',
    'error',
    'depends_on',
    'created_at',
    'started_at',
    'completed_at',
    'task_type',
    'assigned_agent',
    'created_by_task_id',
    'archived_at',
    'active_session',
    'pr_url',
    'pr_number',
    'pr_created_at',
    'input_draft',
    'updated_at',
    'short_id',
    'restrictions',
  ];
  const selectExpr = allNewColumns
    .map((col) => (oldColumns.has(col) ? col : `NULL AS ${col}`))
    .join(', ');
  db.exec(`INSERT INTO tasks_migration49_new SELECT ${selectExpr} FROM tasks`);
  db.exec(`DROP TABLE tasks`);
  db.exec(`ALTER TABLE tasks_migration49_new RENAME TO tasks`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room_updated ON tasks(room_id, updated_at DESC)`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_room_short_id ON tasks(room_id, short_id) WHERE short_id IS NOT NULL`
  );
}

export function runMigration51(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;

  const hasSlotRole = tableHasColumn(db, 'space_tasks', 'slot_role');
  const hasAgentName = tableHasColumn(db, 'space_tasks', 'agent_name');
  const hasCompletionSummary = tableHasColumn(db, 'space_tasks', 'completion_summary');

  if (!hasSlotRole && hasAgentName && hasCompletionSummary) {
    return;
  }

  if (!tableHasColumn(db, 'space_tasks', 'task_type')) {
    return;
  }

  db.exec(`PRAGMA foreign_keys = OFF`);
  try {
    db.exec(`BEGIN`);

    if (hasSlotRole) {
      db.exec(`DROP TABLE IF EXISTS space_tasks_m51_new`);
      db.exec(`
				CREATE TABLE space_tasks_m51_new (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					title TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					status TEXT NOT NULL DEFAULT 'pending'
						CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
					priority TEXT NOT NULL DEFAULT 'normal'
						CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
					task_type TEXT
						CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
					assigned_agent TEXT
						CHECK(assigned_agent IN ('coder', 'general')),
					custom_agent_id TEXT,
					agent_name TEXT,
					workflow_run_id TEXT,
					workflow_node_id TEXT,
					created_by_task_id TEXT,
					goal_id TEXT,
					progress INTEGER,
					current_step TEXT,
					result TEXT,
					error TEXT,
					completion_summary TEXT,
					depends_on TEXT NOT NULL DEFAULT '[]',
					input_draft TEXT,
					active_session TEXT
						CHECK(active_session IN ('worker', 'leader')),
					task_agent_session_id TEXT,
					pr_url TEXT,
					pr_number INTEGER,
					pr_created_at INTEGER,
					archived_at INTEGER,
					created_at INTEGER NOT NULL,
					started_at INTEGER,
					completed_at INTEGER,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
					FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
					FOREIGN KEY (workflow_node_id) REFERENCES space_workflow_nodes(id) ON DELETE SET NULL
				)
			`);

      const existingCols = new Set(
        (db.prepare(`PRAGMA table_info(space_tasks)`).all() as Array<{ name: string }>).map(
          (r) => r.name
        )
      );
      const colOrNull = (col: string) => (existingCols.has(col) ? col : `NULL AS ${col}`);

      db.exec(`
				INSERT INTO space_tasks_m51_new
				SELECT
					id,
					space_id,
					title,
					description,
					status,
					priority,
					${colOrNull('task_type')},
					${colOrNull('assigned_agent')},
					${colOrNull('custom_agent_id')},
					slot_role AS agent_name,
					${colOrNull('workflow_run_id')},
					${colOrNull('workflow_node_id')},
					${colOrNull('created_by_task_id')},
					${colOrNull('goal_id')},
					${colOrNull('progress')},
					${colOrNull('current_step')},
					${colOrNull('result')},
					${colOrNull('error')},
					NULL AS completion_summary,
					depends_on,
					${colOrNull('input_draft')},
					${colOrNull('active_session')},
					${colOrNull('task_agent_session_id')},
					${colOrNull('pr_url')},
					${colOrNull('pr_number')},
					${colOrNull('pr_created_at')},
					${colOrNull('archived_at')},
					created_at,
					${colOrNull('started_at')},
					${colOrNull('completed_at')},
					updated_at
				FROM space_tasks
			`);

      db.exec(`DROP TABLE space_tasks`);
      db.exec(`ALTER TABLE space_tasks_m51_new RENAME TO space_tasks`);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_node_id ON space_tasks(workflow_node_id)`
      );
      db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
      );
    } else if (!hasCompletionSummary) {
      db.exec(`ALTER TABLE space_tasks ADD COLUMN completion_summary TEXT`);
    }

    db.exec(`COMMIT`);
  } catch (e) {
    db.exec(`ROLLBACK`);
    throw e;
  } finally {
    db.exec(`PRAGMA foreign_keys = ON`);
  }
}

export function runMigration50(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      source_type TEXT NOT NULL CHECK(source_type IN ('stdio', 'sse', 'http')),
      command TEXT,
      args TEXT,
      env TEXT,
      url TEXT,
      headers TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);
}

export function runMigration52(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_mcp_enablement (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL REFERENCES app_mcp_servers(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (room_id, server_id)
    )
  `);
}

export function runMigration53(db: BunDatabase): void {
  if (!tableHasColumn(db, 'space_workflows', 'channels')) {
    db.exec(`ALTER TABLE space_workflows ADD COLUMN channels TEXT`);

    const rows = db
      .prepare(`SELECT id, config FROM space_workflows WHERE config IS NOT NULL`)
      .all() as Array<{ id: string; config: string }>;

    for (const row of rows) {
      let cfg: Record<string, unknown>;
      try {
        cfg = JSON.parse(row.config) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!cfg.channels) continue;

      const channelsJson = JSON.stringify(cfg.channels);
      delete cfg.channels;
      const updatedConfig = JSON.stringify(cfg);

      db.prepare(`UPDATE space_workflows SET channels = ?, config = ? WHERE id = ?`).run(
        channelsJson,
        updatedConfig,
        row.id
      );
    }
  }
}

export function runMigration54(db: BunDatabase): void {
  if (
    !tableExists(db, 'space_tasks') ||
    !tableHasColumn(db, 'space_tasks', 'workflow_node_id') ||
    !tableHasColumn(db, 'space_tasks', 'agent_name')
  ) {
    return;
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_space_tasks_run_node_agent
    ON space_tasks (workflow_run_id, workflow_node_id, agent_name)
    WHERE workflow_run_id IS NOT NULL
      AND workflow_node_id IS NOT NULL
      AND agent_name IS NOT NULL
      AND status IN ('pending', 'in_progress', 'review', 'rate_limited', 'usage_limited')
  `);
}

export function runMigration55(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) {
    return;
  }

  try {
    db.prepare(`SELECT agent_name FROM space_tasks LIMIT 1`).all();
    return;
  } catch {}

  if (!tableHasColumn(db, 'space_tasks', 'task_type')) {
    return;
  }

  db.exec(`PRAGMA foreign_keys = OFF`);
  db.exec(`BEGIN`);
  try {
    db.exec(`DROP TABLE IF EXISTS space_tasks_new`);

    db.exec(`
			CREATE TABLE space_tasks_new (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived', 'rate_limited', 'usage_limited')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				assigned_agent TEXT
					CHECK(assigned_agent IN ('coder', 'general')),
				custom_agent_id TEXT,
				agent_name TEXT,
				completion_summary TEXT,
				workflow_run_id TEXT,
				workflow_node_id TEXT,
				created_by_task_id TEXT,
				goal_id TEXT,
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				input_draft TEXT,
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
				FOREIGN KEY (workflow_node_id) REFERENCES space_workflow_nodes(id) ON DELETE SET NULL
			)
		`);

    db.exec(`
			INSERT INTO space_tasks_new (
				id, space_id, title, description, status, priority, task_type, assigned_agent,
				custom_agent_id, agent_name, completion_summary, workflow_run_id, workflow_node_id,
				created_by_task_id, goal_id, progress, current_step, result, error, depends_on,
				input_draft, active_session, task_agent_session_id, pr_url, pr_number, pr_created_at,
				archived_at, created_at, started_at, completed_at, updated_at
			)
			SELECT
				id, space_id, title, description, status, priority, task_type, assigned_agent,
				custom_agent_id, slot_role, completion_summary, workflow_run_id, workflow_node_id,
				created_by_task_id, goal_id, progress, current_step, result, error, depends_on,
				input_draft, active_session, task_agent_session_id, pr_url, pr_number, pr_created_at,
				archived_at, created_at, started_at, completed_at, updated_at
			FROM space_tasks
		`);

    db.exec(`DROP TABLE space_tasks`);
    db.exec(`ALTER TABLE space_tasks_new RENAME TO space_tasks`);
    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    throw err;
  } finally {
    db.exec(`PRAGMA foreign_keys = ON`);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_node_id ON space_tasks(workflow_node_id)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
  );
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_space_tasks_run_node_agent
    ON space_tasks (workflow_run_id, workflow_node_id, agent_name)
    WHERE workflow_run_id IS NOT NULL
      AND workflow_node_id IS NOT NULL
      AND agent_name IS NOT NULL
      AND status IN ('pending', 'in_progress', 'review', 'rate_limited', 'usage_limited')
  `);
}

export function runMigration56(db: BunDatabase): void {
  if (!tableExists(db, 'tasks')) return;

  const schemaSql = (
    db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`).get() as
      | { sql: string }
      | undefined
  )?.sql;

  if (schemaSql && schemaSql.includes('planner')) {
    return;
  }

  db.exec(`DROP TABLE IF EXISTS tasks_migration56_new`);
  db.exec(`
		CREATE TABLE tasks_migration56_new (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('draft','pending','in_progress','review','completed','needs_attention','cancelled','archived','rate_limited','usage_limited')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low','normal','high','urgent')),
			progress INTEGER,
			current_step TEXT,
			result TEXT,
			error TEXT,
			depends_on TEXT DEFAULT '[]',
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			task_type TEXT DEFAULT 'coding'
				CHECK(task_type IN ('planning','coding','research','design','goal_review')),
			assigned_agent TEXT DEFAULT 'coder'
				CHECK(assigned_agent IN ('coder','general','planner')),
			created_by_task_id TEXT,
			archived_at INTEGER,
			active_session TEXT,
			pr_url TEXT,
			pr_number INTEGER,
			pr_created_at INTEGER,
			input_draft TEXT,
			updated_at INTEGER,
			short_id TEXT,
			restrictions TEXT,
			FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
		)
	`);

  const oldColumns = new Set(
    (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((r) => r.name)
  );
  const allNewColumns = [
    'id',
    'room_id',
    'title',
    'description',
    'status',
    'priority',
    'progress',
    'current_step',
    'result',
    'error',
    'depends_on',
    'created_at',
    'started_at',
    'completed_at',
    'task_type',
    'assigned_agent',
    'created_by_task_id',
    'archived_at',
    'active_session',
    'pr_url',
    'pr_number',
    'pr_created_at',
    'input_draft',
    'updated_at',
    'short_id',
    'restrictions',
  ];
  const insertColumns = allNewColumns.filter((c) => oldColumns.has(c));
  const selectClause = insertColumns.map((c) => `"${c}"`).join(', ');
  db.exec(`INSERT INTO tasks_migration56_new (${selectClause}) SELECT ${selectClause} FROM tasks`);
  db.exec(`DROP TABLE tasks`);
  db.exec(`ALTER TABLE tasks_migration56_new RENAME TO tasks`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_room_updated ON tasks(room_id, updated_at DESC)`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_room_short_id ON tasks(room_id, short_id) WHERE short_id IS NOT NULL`
  );
}

export function runMigration57(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL,
      source_type TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      built_in INTEGER NOT NULL DEFAULT 0,
      validation_status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    )
  `);
}

export function runMigration58(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_skill_overrides (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (skill_id, room_id)
    )
  `);
}

export function runMigration59(db: BunDatabase): void {
  db.exec(`DROP TABLE IF EXISTS space_workflow_transitions`);
}

export function runMigration62(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;

  const cols = db.prepare('PRAGMA table_info(space_tasks)').all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'task_number')) return;

  db.exec(`PRAGMA foreign_keys = OFF`);
  db.exec(`BEGIN`);
  try {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN task_number INTEGER`);

    const spaces = db.prepare(`SELECT DISTINCT space_id FROM space_tasks`).all() as Array<{
      space_id: string;
    }>;
    for (const { space_id } of spaces) {
      const tasks = db
        .prepare(`SELECT id FROM space_tasks WHERE space_id = ? ORDER BY created_at ASC`)
        .all(space_id) as Array<{ id: string }>;
      const updateStmt = db.prepare(`UPDATE space_tasks SET task_number = ? WHERE id = ?`);
      let num = 1;
      for (const { id } of tasks) {
        updateStmt.run(num++, id);
      }
    }

    db.exec(`DROP TABLE IF EXISTS space_tasks_m61_new`);
    db.exec(`
			CREATE TABLE space_tasks_m61_new (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				task_number INTEGER NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed',
						'needs_attention', 'cancelled', 'archived', 'rate_limited', 'usage_limited')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				task_type TEXT
					CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'review')),
				assigned_agent TEXT
					CHECK(assigned_agent IN ('coder', 'general', 'planner')),
				custom_agent_id TEXT,
				agent_name TEXT,
				completion_summary TEXT,
				workflow_run_id TEXT,
				workflow_node_id TEXT,
				created_by_task_id TEXT,
				goal_id TEXT,
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				input_draft TEXT,
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL,
				FOREIGN KEY (workflow_node_id) REFERENCES space_workflow_nodes(id) ON DELETE SET NULL
			)
		`);

    db.exec(`
			INSERT INTO space_tasks_m61_new
			SELECT id, space_id, task_number, title, description, status, priority, task_type,
				assigned_agent, custom_agent_id, agent_name, completion_summary,
				workflow_run_id, workflow_node_id, created_by_task_id, goal_id,
				progress, current_step, result, error, depends_on, input_draft,
				active_session, task_agent_session_id, pr_url, pr_number, pr_created_at,
				archived_at, created_at, started_at, completed_at, updated_at
			FROM space_tasks
		`);

    db.exec(`DROP TABLE space_tasks`);
    db.exec(`ALTER TABLE space_tasks_m61_new RENAME TO space_tasks`);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_status ON space_tasks(status)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_tasks_custom_agent_id ON space_tasks(custom_agent_id)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_node_id ON space_tasks(workflow_node_id)`
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_tasks_task_agent_session_id ON space_tasks(task_agent_session_id)`
    );
    db.exec(`
			CREATE UNIQUE INDEX IF NOT EXISTS uq_space_tasks_run_node_agent
			ON space_tasks (workflow_run_id, workflow_node_id, agent_name)
			WHERE workflow_run_id IS NOT NULL
				AND workflow_node_id IS NOT NULL
				AND agent_name IS NOT NULL
				AND status IN ('pending', 'in_progress', 'review', 'rate_limited', 'usage_limited')
		`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_space_tasks_space_task_number ON space_tasks(space_id, task_number)`
    );

    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    throw err;
  } finally {
    db.exec(`PRAGMA foreign_keys = ON`);
  }
}

export function runMigration60(db: BunDatabase): void {
  db.exec(`PRAGMA foreign_keys = OFF`);
  db.exec(`BEGIN`);
  try {
    db.exec(`DROP TABLE IF EXISTS space_session_group_members`);
    db.exec(`DROP TABLE IF EXISTS space_session_groups`);

    db.exec(`DROP INDEX IF EXISTS idx_space_session_groups_task_id`);
    db.exec(`DROP INDEX IF EXISTS idx_space_session_group_members_group`);
    db.exec(`DROP INDEX IF EXISTS idx_space_session_group_members_session`);

    if (tableExists(db, 'space_workflow_runs')) {
      const runTableInfo = db.prepare('PRAGMA table_info(space_workflow_runs)').all() as Array<{
        name: string;
      }>;
      if (runTableInfo.some((col) => col.name === 'current_node_id')) {
        db.exec(`DROP TABLE IF EXISTS space_workflow_runs_m60_new`);
        db.exec(`
					CREATE TABLE space_workflow_runs_m60_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						workflow_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT,
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'needs_attention')),
						config TEXT,
						iteration_count INTEGER NOT NULL DEFAULT 0,
						max_iterations INTEGER NOT NULL DEFAULT 10,
						goal_id TEXT,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						completed_at INTEGER,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
					)
				`);
        db.exec(`
					INSERT INTO space_workflow_runs_m60_new (id, space_id, workflow_id, title, description, status, config, iteration_count, max_iterations, goal_id, created_at, updated_at, completed_at)
					SELECT id, space_id, workflow_id, title, description, status, config, iteration_count, max_iterations, goal_id, created_at, updated_at, completed_at
					FROM space_workflow_runs
				`);
        db.exec(`DROP TABLE space_workflow_runs`);
        db.exec(`ALTER TABLE space_workflow_runs_m60_new RENAME TO space_workflow_runs`);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_space ON space_workflow_runs(space_id)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_workflow ON space_workflow_runs(workflow_id)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_status ON space_workflow_runs(status)`
        );
      }
    }

    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    throw err;
  } finally {
    db.exec(`PRAGMA foreign_keys = ON`);
  }
}

function runMigration61(db: BunDatabase): void {
  const hasGatesCol = db
    .prepare(
      "SELECT COUNT(*) as count FROM pragma_table_info('space_workflows') WHERE name = 'gates'"
    )
    .get() as { count: number } | null;
  const hasFailureReasonCol = db
    .prepare(
      "SELECT COUNT(*) as count FROM pragma_table_info('space_workflow_runs') WHERE name = 'failure_reason'"
    )
    .get() as { count: number } | null;
  const hasGateDataTable = db
    .prepare(
      "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = 'gate_data'"
    )
    .get() as { count: number } | null;

  if (
    hasGatesCol &&
    hasGatesCol.count > 0 &&
    hasFailureReasonCol &&
    hasFailureReasonCol.count > 0 &&
    hasGateDataTable &&
    hasGateDataTable.count > 0
  ) {
    return;
  }

  db.exec(`BEGIN TRANSACTION`);
  try {
    db.exec(`
			CREATE TABLE IF NOT EXISTS gate_data (
				run_id TEXT NOT NULL,
				gate_id TEXT NOT NULL,
				data TEXT NOT NULL DEFAULT '{}',
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (run_id, gate_id),
				FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
			)
		`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gate_data_run ON gate_data(run_id)`);

    if (!hasGatesCol || hasGatesCol.count === 0) {
      db.exec(`ALTER TABLE space_workflows ADD COLUMN gates TEXT`);
    }

    if (!hasFailureReasonCol || hasFailureReasonCol.count === 0) {
      db.exec(
        `ALTER TABLE space_workflow_runs ADD COLUMN failure_reason TEXT CHECK(failure_reason IN ('humanRejected', 'maxIterationsReached', 'nodeTimeout', 'agentCrash'))`
      );
    }

    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    throw err;
  }
}

export function runMigration63(db: BunDatabase): void {
  if (!tableExists(db, 'spaces')) return;

  const tableInfo = db.prepare('PRAGMA table_info(spaces)').all() as Array<{
    name: string;
    notnull: number;
  }>;
  const slugCol = tableInfo.find((col) => col.name === 'slug');
  if (slugCol && slugCol.notnull === 1) return;

  db.exec(`PRAGMA foreign_keys = OFF`);
  db.exec(`BEGIN`);

  try {
    if (!slugCol) {
      db.exec(`ALTER TABLE spaces ADD COLUMN slug TEXT`);
    }

    const existingSlugs = db
      .prepare('SELECT slug FROM spaces WHERE slug IS NOT NULL')
      .all() as Array<{ slug: string }>;
    const usedSlugs = new Set<string>(existingSlugs.map((r) => r.slug));

    const rows = db.prepare('SELECT id, name FROM spaces WHERE slug IS NULL').all() as Array<{
      id: string;
      name: string;
    }>;

    const updateStmt = db.prepare('UPDATE spaces SET slug = ? WHERE id = ? AND slug IS NULL');

    for (const row of rows) {
      const base = generateBaseMigrationSlug(row.name);
      let slug = base;
      let counter = 2;
      while (usedSlugs.has(slug)) {
        slug = `${base}-${counter}`;
        counter++;
      }
      usedSlugs.add(slug);
      updateStmt.run(slug, row.id);
    }

    db.exec(`DROP TABLE IF EXISTS spaces_m63_new`);
    db.exec(`
			CREATE TABLE spaces_m63_new (
				id TEXT PRIMARY KEY,
				slug TEXT NOT NULL,
				workspace_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				handle TEXT,
				description TEXT NOT NULL DEFAULT '',
				background_context TEXT NOT NULL DEFAULT '',
				instructions TEXT NOT NULL DEFAULT '',
				default_model TEXT,
				allowed_models TEXT NOT NULL DEFAULT '[]',
				session_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active'
					CHECK(status IN ('active', 'archived')),
				autonomy_level TEXT NOT NULL DEFAULT 'supervised',
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`
			INSERT INTO spaces_m63_new (id, slug, workspace_path, name, description,
				background_context, instructions, default_model, allowed_models,
				session_ids, status, autonomy_level, config, created_at, updated_at)
			SELECT id, slug, workspace_path, name, description,
				background_context, instructions, default_model, allowed_models,
				session_ids, status, COALESCE(autonomy_level, 'supervised'),
				config, created_at, updated_at
			FROM spaces
		`);
    db.exec(`DROP TABLE spaces`);
    db.exec(`ALTER TABLE spaces_m63_new RENAME TO spaces`);

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_slug ON spaces(slug)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status)`);

    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    throw err;
  } finally {
    db.exec(`PRAGMA foreign_keys = ON`);
  }
}

function generateBaseMigrationSlug(input: string): string {
  const fallback = 'unnamed-space';
  if (!input || !input.trim()) return fallback;

  let slug = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '-')
    .replace(/[\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  if (!slug) return fallback;

  if (slug.length > 60) {
    const truncated = slug.slice(0, 60);
    const lastHyphen = truncated.lastIndexOf('-');
    slug = lastHyphen > 0 ? truncated.slice(0, lastHyphen) : truncated.replace(/-+$/, '');
  }

  return slug;
}

function runMigration64(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_worktrees (
			id         TEXT PRIMARY KEY,
			space_id   TEXT NOT NULL,
			task_id    TEXT NOT NULL,
			slug       TEXT NOT NULL,
			path       TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			UNIQUE(space_id, task_id),
			UNIQUE(space_id, slug),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (task_id) REFERENCES space_tasks(id) ON DELETE CASCADE
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_worktrees_space_id ON space_worktrees(space_id)`);
}

function runMigration65(db: BunDatabase): void {
  try {
    db.prepare(`SELECT completed_at FROM space_worktrees LIMIT 1`).all();
  } catch {
    db.exec(`ALTER TABLE space_worktrees ADD COLUMN completed_at INTEGER`);
  }
}

export function runMigration66(db: BunDatabase): void {
  if (tableExists(db, 'sessions')) {
    const sessionsSql = tableCreateSql(db, 'sessions');
    if (sessionsSql && !sessionsSql.includes("'neo'")) {
      return;
    }
  }

  if (tableExists(db, 'sessions')) {
    try {
      const testId = '__migration_test_neo_type__';
      db.prepare(
        `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        testId,
        'Test',
        '/tmp',
        new Date().toISOString(),
        new Date().toISOString(),
        'active',
        '{}',
        '{}',
        0,
        'neo'
      );
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
    } catch {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec(`
					CREATE TABLE sessions_new (
						id TEXT PRIMARY KEY,
						title TEXT NOT NULL,
						workspace_path TEXT NOT NULL,
						created_at TEXT NOT NULL,
						last_active_at TEXT NOT NULL,
						status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
						config TEXT NOT NULL,
						metadata TEXT NOT NULL,
						is_worktree INTEGER DEFAULT 0,
						worktree_path TEXT,
						main_repo_path TEXT,
						worktree_branch TEXT,
						git_branch TEXT,
						sdk_session_id TEXT,
						available_commands TEXT,
						processing_state TEXT,
						archived_at TEXT,
						parent_id TEXT,
						type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global', 'space_task_agent', 'neo')),
						session_context TEXT
					)
				`);
        db.exec(`
					INSERT INTO sessions_new
					SELECT id, title, workspace_path, created_at, last_active_at,
						status, config, metadata, is_worktree, worktree_path, main_repo_path,
						worktree_branch, git_branch, sdk_session_id, available_commands,
						processing_state, archived_at, parent_id, type, session_context
					FROM sessions
				`);
        db.exec(`DROP TABLE sessions`);
        db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  db.exec(`
		CREATE TABLE IF NOT EXISTS neo_activity_log (
			id          TEXT PRIMARY KEY,
			tool_name   TEXT NOT NULL,
			input       TEXT,
			output      TEXT,
			status      TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'error', 'cancelled')),
			error       TEXT,
			target_type TEXT,
			target_id   TEXT,
			undoable    INTEGER DEFAULT 0,
			undo_data   TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_neo_activity_log_created_at ON neo_activity_log(created_at)`
  );
}

function runMigration67(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) return;

  try {
    const testId = '__migration_test_space_chat_type__';
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      testId,
      'Test',
      '/tmp',
      new Date().toISOString(),
      new Date().toISOString(),
      'active',
      '{}',
      '{}',
      0,
      'space_chat'
    );
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(testId);
  } catch {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec(`
				CREATE TABLE sessions_new (
					id TEXT PRIMARY KEY,
					title TEXT NOT NULL,
					workspace_path TEXT NOT NULL,
					created_at TEXT NOT NULL,
					last_active_at TEXT NOT NULL,
					status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
					config TEXT NOT NULL,
					metadata TEXT NOT NULL,
					is_worktree INTEGER DEFAULT 0,
					worktree_path TEXT,
					main_repo_path TEXT,
					worktree_branch TEXT,
					git_branch TEXT,
					sdk_session_id TEXT,
					available_commands TEXT,
					processing_state TEXT,
					archived_at TEXT,
					parent_id TEXT,
					type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global', 'space_task_agent', 'neo', 'space_chat')),
					session_context TEXT
				)
			`);
      db.exec(`
				INSERT INTO sessions_new
				SELECT id, title, workspace_path, created_at, last_active_at,
					status, config, metadata, is_worktree, worktree_path, main_repo_path,
					worktree_branch, git_branch, sdk_session_id, available_commands,
					processing_state, archived_at, parent_id, type, session_context
				FROM sessions
			`);
      db.exec(`DROP TABLE sessions`);
      db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

export function runMigration69(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflow_runs')) return;
  if (tableExists(db, 'channel_cycles')) return;

  db.exec(`
		CREATE TABLE channel_cycles (
			run_id TEXT NOT NULL,
			channel_index INTEGER NOT NULL,
			count INTEGER NOT NULL DEFAULT 0,
			max_cycles INTEGER NOT NULL DEFAULT 5,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (run_id, channel_index),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);
}

export function runMigration68(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) {
    return;
  }
  const columns = db.prepare(`PRAGMA table_info(sdk_messages)`).all() as Array<{ name: string }>;
  const hasOrigin = columns.some((col) => col.name === 'origin');
  if (!hasOrigin) {
    db.exec(
      `ALTER TABLE sdk_messages ADD COLUMN origin TEXT DEFAULT NULL CHECK(origin IS NULL OR origin IN ('human', 'neo', 'system'))`
    );
  }
}

export function runMigration70(db: BunDatabase): void {
  if (!tableExists(db, 'rooms')) return;

  const roomColumns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
  const hasDefaultPath = roomColumns.some((col) => col.name === 'default_path');
  if (!hasDefaultPath) {
    db.exec(`ALTER TABLE rooms ADD COLUMN default_path TEXT`);
  }
  const hasAllowedPaths = roomColumns.some((col) => col.name === 'allowed_paths');
  if (!hasAllowedPaths) {
    db.exec(`ALTER TABLE rooms ADD COLUMN allowed_paths TEXT DEFAULT '[]'`);
  }

  const nullCount = (
    db.prepare(`SELECT COUNT(*) as cnt FROM rooms WHERE default_path IS NULL`).get() as {
      cnt: number;
    }
  ).cnt;
  if (nullCount === 0) return;

  const rows = db
    .prepare(`SELECT id, allowed_paths FROM rooms WHERE default_path IS NULL`)
    .all() as Array<{ id: string; allowed_paths: string | null }>;

  const update = db.prepare(`UPDATE rooms SET default_path = ? WHERE id = ?`);

  for (const row of rows) {
    let newPath: string = '__NEEDS_WORKSPACE_PATH__';
    try {
      const parsed = JSON.parse(row.allowed_paths ?? '[]');
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.path) {
        newPath = parsed[0].path as string;
      }
    } catch {}
    update.run(newPath, row.id);
  }
}

export function runMigration71(db: BunDatabase): void {
  if (!tableExists(db, 'goals')) return;

  const goalColumns = db.prepare(`PRAGMA table_info(goals)`).all() as Array<{ name: string }>;
  const hasSchedule = goalColumns.some((col) => col.name === 'schedule');
  if (!hasSchedule) return;

  const rows = db
    .prepare(`SELECT id, schedule FROM goals WHERE schedule IS NOT NULL`)
    .all() as Array<{ id: string; schedule: string }>;

  if (rows.length === 0) return;

  const update = db.prepare(`UPDATE goals SET schedule = ? WHERE id = ?`);

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.schedule);
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.expression === 'string') {
        continue;
      }
      if (typeof parsed === 'string') {
        const fixedVal = JSON.stringify({ expression: parsed, timezone: 'UTC' });
        update.run(fixedVal, row.id);
      }
    } catch {
      const fixedVal = JSON.stringify({ expression: row.schedule, timezone: 'UTC' });
      update.run(fixedVal, row.id);
    }
  }
}

export function runMigration72(db: BunDatabase): void {
  if (tableExists(db, 'rooms') && tableHasColumn(db, 'rooms', 'status')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_rooms_status_updated ON rooms(status, updated_at DESC)`
    );
  }

  if (tableExists(db, 'sessions') && tableHasColumn(db, 'sessions', 'type')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions(type)`);
  }

  if (tableExists(db, 'sessions') && tableHasColumn(db, 'sessions', 'status')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_status_last_active ON sessions(status, last_active_at DESC)`
    );
  }
}

function runMigration73(db: BunDatabase): void {
  if (tableExists(db, 'space_tasks')) {
    const needsTasksUpdate =
      !statusCheckContains(db, 'space_tasks', 'open') ||
      !tableHasColumn(db, 'space_tasks', 'labels') ||
      tableHasColumn(db, 'space_tasks', 'task_type');

    if (needsTasksUpdate) {
      const hasPrCols = tableHasColumn(db, 'space_tasks', 'pr_url');

      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN');
      try {
        db.exec(`
					CREATE TABLE space_tasks_m71_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						task_number INTEGER NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						status TEXT NOT NULL DEFAULT 'open'
							CHECK(status IN ('open', 'in_progress', 'done', 'blocked', 'cancelled', 'archived')),
						priority TEXT NOT NULL DEFAULT 'normal'
							CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						labels TEXT NOT NULL DEFAULT '[]',
						workflow_run_id TEXT,
						created_by_task_id TEXT,
						result TEXT,
						depends_on TEXT NOT NULL DEFAULT '[]',
						active_session TEXT
							CHECK(active_session IN ('worker', 'leader')),
						task_agent_session_id TEXT,
						${
              hasPrCols
                ? `pr_url TEXT,
						pr_number INTEGER,
						pr_created_at INTEGER,`
                : ''
            }
						archived_at INTEGER,
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						updated_at INTEGER NOT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL
					)
				`);

        const prInsertCols = hasPrCols ? ', pr_url, pr_number, pr_created_at' : '';
        const prSelectCols = hasPrCols ? ', pr_url, pr_number, pr_created_at' : '';
        db.exec(`
					INSERT INTO space_tasks_m71_new
					  (id, space_id, task_number, title, description, status, priority, labels,
					   workflow_run_id, created_by_task_id, result, depends_on,
					   active_session, task_agent_session_id${prInsertCols},
					   archived_at, created_at, started_at, completed_at, updated_at)
					SELECT
					  id, space_id, task_number, title, description,
					  CASE status
					    WHEN 'draft'           THEN 'open'
					    WHEN 'pending'         THEN 'open'
					    WHEN 'completed'       THEN 'done'
					    WHEN 'review'          THEN 'blocked'
					    WHEN 'needs_attention' THEN 'blocked'
					    WHEN 'rate_limited'    THEN 'blocked'
					    WHEN 'usage_limited'   THEN 'blocked'
					    ELSE status
					  END,
					  priority, '[]',
					  workflow_run_id, created_by_task_id, result, depends_on,
					  active_session, task_agent_session_id${prSelectCols},
					  archived_at, created_at, started_at, completed_at, updated_at
					FROM space_tasks
				`);

        db.exec(`DROP TABLE space_tasks`);
        db.exec(`ALTER TABLE space_tasks_m71_new RENAME TO space_tasks`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
        );
        db.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_space_tasks_task_number ON space_tasks(space_id, task_number)`
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  if (tableExists(db, 'space_workflow_runs')) {
    const needsRunsUpdate =
      !statusCheckContains(db, 'space_workflow_runs', 'done') ||
      !tableHasColumn(db, 'space_workflow_runs', 'started_at') ||
      tableHasColumn(db, 'space_workflow_runs', 'config');

    if (needsRunsUpdate) {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN');
      try {
        db.exec(`
					CREATE TABLE space_workflow_runs_m71_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						workflow_id TEXT NOT NULL,
						title TEXT NOT NULL,
						description TEXT,
						status TEXT NOT NULL DEFAULT 'pending'
							CHECK(status IN ('pending', 'in_progress', 'done', 'blocked', 'cancelled')),
						failure_reason TEXT,
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						updated_at INTEGER NOT NULL,
						completed_at INTEGER,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
					)
				`);

        db.exec(`
					INSERT INTO space_workflow_runs_m71_new
					  (id, space_id, workflow_id, title, description, status, failure_reason,
					   created_at, updated_at, completed_at)
					SELECT
					  id, space_id, workflow_id, title, description,
					  CASE status
					    WHEN 'completed'      THEN 'done'
					    WHEN 'needs_attention' THEN 'blocked'
					    ELSE status
					  END,
					  failure_reason,
					  created_at, updated_at, completed_at
					FROM space_workflow_runs
				`);

        db.exec(`DROP TABLE space_workflow_runs`);
        db.exec(`ALTER TABLE space_workflow_runs_m71_new RENAME TO space_workflow_runs`);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_space_id ON space_workflow_runs(space_id)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_space_workflow_runs_workflow_id ON space_workflow_runs(workflow_id)`
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  if (tableExists(db, 'space_workflows') && !tableHasColumn(db, 'space_workflows', 'end_node_id')) {
    db.exec(`ALTER TABLE space_workflows ADD COLUMN end_node_id TEXT`);
  }

  if (tableExists(db, 'space_agents') && !tableHasColumn(db, 'space_agents', 'instructions')) {
    db.exec(`ALTER TABLE space_agents ADD COLUMN instructions TEXT`);
  }
}

export function runMigration74(db: BunDatabase): void {
  if (!tableExists(db, 'node_executions')) {
    try {
      db.exec('BEGIN');
      db.exec(`
				CREATE TABLE node_executions (
					id TEXT PRIMARY KEY,
					workflow_run_id TEXT NOT NULL,
					workflow_node_id TEXT NOT NULL,
					agent_name TEXT NOT NULL,
					agent_id TEXT,
					agent_session_id TEXT,
					status TEXT NOT NULL DEFAULT 'pending'
						CHECK(status IN ('pending', 'in_progress', 'done', 'blocked', 'cancelled')),
					result TEXT,
					created_at INTEGER NOT NULL,
					started_at INTEGER,
					completed_at INTEGER,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE,
					FOREIGN KEY (agent_id) REFERENCES space_agents(id) ON DELETE SET NULL
				)
			`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_node_executions_run ON node_executions(workflow_run_id)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_node_executions_node ON node_executions(workflow_run_id, workflow_node_id)`
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  if (tableExists(db, 'space_workflows') && tableHasColumn(db, 'space_workflows', 'config')) {
    const wfRows = db.prepare(`SELECT id, config FROM space_workflows`).all() as Array<{
      id: string;
      config: string | null;
    }>;
    const tagsMap = new Map<string, string>();
    for (const row of wfRows) {
      if (!row.config) {
        tagsMap.set(row.id, '[]');
        continue;
      }
      try {
        const cfg = JSON.parse(row.config) as Record<string, unknown>;
        const tags = Array.isArray(cfg.tags) ? cfg.tags : [];
        tagsMap.set(row.id, JSON.stringify(tags));
      } catch {
        tagsMap.set(row.id, '[]');
      }
    }

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
				CREATE TABLE space_workflows_m74_new (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					start_node_id TEXT,
					end_node_id TEXT,
					tags TEXT NOT NULL DEFAULT '[]',
					layout TEXT,
					channels TEXT,
					gates TEXT,
					disabled INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
				)
			`);

      db.exec(`
				INSERT INTO space_workflows_m74_new
				  (id, space_id, name, description, start_node_id, end_node_id, tags,
				   layout, channels, gates, created_at, updated_at)
				SELECT
				  id, space_id, name, description, start_node_id, end_node_id, '[]',
				  layout, channels, gates, created_at, updated_at
				FROM space_workflows
			`);

      db.exec(`DROP TABLE space_workflows`);
      db.exec(`ALTER TABLE space_workflows_m74_new RENAME TO space_workflows`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_workflows_space_id ON space_workflows(space_id)`
      );

      const updateTags = db.prepare(`UPDATE space_workflows SET tags = ? WHERE id = ?`);
      for (const [id, tags] of tagsMap) {
        updateTags.run(tags, id);
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  if (
    tableExists(db, 'space_workflow_nodes') &&
    tableHasColumn(db, 'space_workflow_nodes', 'order_index')
  ) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
				CREATE TABLE space_workflow_nodes_m74_new (
					id TEXT PRIMARY KEY,
					workflow_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					config TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
				)
			`);

      db.exec(`
				INSERT INTO space_workflow_nodes_m74_new
				  (id, workflow_id, name, description, config, created_at, updated_at)
				SELECT
				  id, workflow_id, name, description, config, created_at, updated_at
				FROM space_workflow_nodes
			`);

      db.exec(`DROP TABLE space_workflow_nodes`);
      db.exec(`ALTER TABLE space_workflow_nodes_m74_new RENAME TO space_workflow_nodes`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_space_workflow_nodes_workflow_id ON space_workflow_nodes(workflow_id)`
      );

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  if (tableExists(db, 'space_agents') && tableHasColumn(db, 'space_agents', 'role')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
				CREATE TABLE space_agents_m74_new (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					model TEXT,
					tools TEXT NOT NULL DEFAULT '[]',
					system_prompt TEXT NOT NULL DEFAULT '',
					provider TEXT,
					instructions TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
				)
			`);

      db.exec(`
				INSERT INTO space_agents_m74_new
				  (id, space_id, name, description, model, tools, system_prompt, provider,
				   instructions, created_at, updated_at)
				SELECT
				  id, space_id, name, description, model, tools, system_prompt, provider,
				  instructions, created_at, updated_at
				FROM space_agents
			`);

      db.exec(`DROP TABLE space_agents`);
      db.exec(`ALTER TABLE space_agents_m74_new RENAME TO space_agents`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_space_agents_space_id ON space_agents(space_id)`);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  if (tableExists(db, 'space_workflow_nodes')) {
    const nodeRows = db
      .prepare(`SELECT id, config FROM space_workflow_nodes WHERE config IS NOT NULL`)
      .all() as Array<{ id: string; config: string }>;

    const updateNodeConfig = db.prepare(`UPDATE space_workflow_nodes SET config = ? WHERE id = ?`);

    for (const row of nodeRows) {
      let cfg: Record<string, unknown>;
      try {
        cfg = JSON.parse(row.config) as Record<string, unknown>;
      } catch {
        continue;
      }

      const agents = cfg.agents;
      if (!Array.isArray(agents)) continue;

      let changed = false;
      for (const agent of agents as Array<Record<string, unknown>>) {
        if (typeof agent.systemPrompt === 'string' && agent.systemPrompt) {
          agent.systemPrompt = { mode: 'override', value: agent.systemPrompt };
          changed = true;
        }

        if (typeof agent.instructions === 'string' && agent.instructions) {
          agent.instructions = { mode: 'override', value: agent.instructions };
          changed = true;
        }
      }

      if (changed) {
        updateNodeConfig.run(JSON.stringify(cfg), row.id);
      }
    }
  }
}

function runMigration75(db: BunDatabase): void {
  if (!tableExists(db, 'node_executions')) return;

  db.transaction(() => {
    db.prepare(`
			DELETE FROM node_executions
			WHERE rowid NOT IN (
				SELECT MIN(rowid)
				FROM node_executions
				GROUP BY workflow_run_id, workflow_node_id, agent_name
			)
		`).run();

    db.exec(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_node_executions_unique_agent
			ON node_executions(workflow_run_id, workflow_node_id, agent_name)
		`);
  })();
}

function runMigration76(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;

  const needsUpdate = !statusCheckContains(db, 'space_tasks', 'review');

  if (!needsUpdate) return;

  const hasPrCols = tableHasColumn(db, 'space_tasks', 'pr_url');

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
			CREATE TABLE space_tasks_m76_new (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				task_number INTEGER NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'open'
					CHECK(status IN ('open', 'in_progress', 'review', 'done', 'blocked', 'cancelled', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				labels TEXT NOT NULL DEFAULT '[]',
				workflow_run_id TEXT,
				created_by_task_id TEXT,
				result TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				${
          hasPrCols
            ? `pr_url TEXT,
				pr_number INTEGER,
				pr_created_at INTEGER,`
            : ''
        }
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL
			)
		`);

    const prInsertCols = hasPrCols ? ', pr_url, pr_number, pr_created_at' : '';
    const prSelectCols = hasPrCols ? ', pr_url, pr_number, pr_created_at' : '';
    db.exec(`
			INSERT INTO space_tasks_m76_new
			  (id, space_id, task_number, title, description, status, priority, labels,
			   workflow_run_id, created_by_task_id, result, depends_on,
			   active_session, task_agent_session_id${prInsertCols},
			   archived_at, created_at, started_at, completed_at, updated_at)
			SELECT
			  id, space_id, task_number, title, description, status, priority, labels,
			  workflow_run_id, created_by_task_id, result, depends_on,
			  active_session, task_agent_session_id${prSelectCols},
			  archived_at, created_at, started_at, completed_at, updated_at
			FROM space_tasks
		`);

    db.exec(`DROP TABLE space_tasks`);
    db.exec(`ALTER TABLE space_tasks_m76_new RENAME TO space_tasks`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_space_tasks_task_number ON space_tasks(space_id, task_number)`
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function runMigration77(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) return;

  const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  const workspaceCol = columns.find((c) => c.name === 'workspace_path');
  if (!workspaceCol || workspaceCol.notnull === 0) {
    return;
  }

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
			CREATE TABLE sessions_new (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				workspace_path TEXT,
				created_at TEXT NOT NULL,
				last_active_at TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
				config TEXT NOT NULL,
				metadata TEXT NOT NULL,
				is_worktree INTEGER DEFAULT 0,
				worktree_path TEXT,
				main_repo_path TEXT,
				worktree_branch TEXT,
				git_branch TEXT,
				sdk_session_id TEXT,
				available_commands TEXT,
				processing_state TEXT,
				archived_at TEXT,
				parent_id TEXT,
				type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global', 'space_task_agent', 'space_chat', 'neo')),
				session_context TEXT
			)
		`);
    db.exec(`
			INSERT INTO sessions_new
			SELECT id, title, workspace_path, created_at, last_active_at,
				status, config, metadata, is_worktree, worktree_path, main_repo_path,
				worktree_branch, git_branch, sdk_session_id, available_commands,
				processing_state, archived_at, parent_id, type, session_context
			FROM sessions
		`);
    db.exec(`DROP TABLE sessions`);
    db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function runMigration78(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS workspace_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			path TEXT NOT NULL UNIQUE,
			last_used_at INTEGER NOT NULL,
			use_count INTEGER NOT NULL DEFAULT 1
		)
	`);
}

function runMigration79(db: BunDatabase): void {
  if (!tableExists(db, 'node_executions')) return;

  const needsStatusUpdate =
    !tableHasColumn(db, 'node_executions', 'data') ||
    !statusCheckContains(db, 'node_executions', 'idle');

  if (!needsStatusUpdate) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
			CREATE TABLE node_executions_m78_new (
				id TEXT PRIMARY KEY,
				workflow_run_id TEXT NOT NULL,
				workflow_node_id TEXT NOT NULL,
				agent_name TEXT NOT NULL,
				agent_id TEXT,
				agent_session_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'in_progress', 'idle', 'done', 'blocked', 'cancelled')),
				result TEXT,
				data TEXT,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE,
				FOREIGN KEY (agent_id) REFERENCES space_agents(id) ON DELETE SET NULL
			)
		`);

    db.exec(`
			INSERT INTO node_executions_m78_new
			  (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
			   agent_session_id, status, result, data, created_at, started_at,
			   completed_at, updated_at)
			SELECT
			  id, workflow_run_id, workflow_node_id, agent_name, agent_id,
			  agent_session_id, status, result, NULL, created_at, started_at,
			  completed_at, updated_at
			FROM node_executions
		`);

    db.exec(`DROP TABLE node_executions`);
    db.exec(`ALTER TABLE node_executions_m78_new RENAME TO node_executions`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_node_executions_run ON node_executions(workflow_run_id)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_node_executions_node ON node_executions(workflow_run_id, workflow_node_id)`
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_node_executions_unique_slot
			   ON node_executions(workflow_run_id, workflow_node_id, agent_name)`
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function runMigration80(db: BunDatabase): void {
  if (!tableExists(db, 'space_agents')) return;
  if (tableHasColumn(db, 'space_agents', 'custom_prompt')) return;

  db.exec(`ALTER TABLE space_agents ADD COLUMN custom_prompt TEXT`);

  db.exec(`
		UPDATE space_agents
		SET custom_prompt = CASE
			WHEN (system_prompt IS NOT NULL AND system_prompt != '')
			     AND (instructions IS NOT NULL AND instructions != '')
				THEN system_prompt || char(10) || char(10) || instructions
			WHEN (system_prompt IS NOT NULL AND system_prompt != '')
				THEN system_prompt
			WHEN (instructions IS NOT NULL AND instructions != '')
				THEN instructions
			ELSE NULL
		END
	`);
}

function runMigration81(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;
  if (tableHasColumn(db, 'space_tasks', 'preferred_workflow_id')) return;

  db.exec(`ALTER TABLE space_tasks ADD COLUMN preferred_workflow_id TEXT`);
}

function runMigration82(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;
  if (tableHasColumn(db, 'space_tasks', 'approval_source')) return;

  db.exec(`ALTER TABLE space_tasks ADD COLUMN approval_source TEXT`);
  db.exec(`ALTER TABLE space_tasks ADD COLUMN approval_reason TEXT`);
  db.exec(`ALTER TABLE space_tasks ADD COLUMN approved_at INTEGER`);
}

function runMigration83(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;
  if (tableHasColumn(db, 'space_tasks', 'block_reason')) return;

  db.exec(`ALTER TABLE space_tasks ADD COLUMN block_reason TEXT`);
}

function runMigration84(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS workflow_run_artifacts (
			id TEXT PRIMARY KEY NOT NULL,
			run_id TEXT NOT NULL,
			node_id TEXT NOT NULL,
			artifact_type TEXT NOT NULL,
			artifact_key TEXT NOT NULL DEFAULT '',
			data TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(run_id, node_id, artifact_type, artifact_key),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wra_run_id ON workflow_run_artifacts(run_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wra_run_node ON workflow_run_artifacts(run_id, node_id)`);

  if (!tableExists(db, 'space_tasks')) return;
  if (!tableHasColumn(db, 'space_tasks', 'pr_url')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
			CREATE TABLE space_tasks_m84_new (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				task_number INTEGER NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'open'
					CHECK(status IN ('open', 'in_progress', 'review', 'done', 'blocked', 'cancelled', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal'
					CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				labels TEXT NOT NULL DEFAULT '[]',
				workflow_run_id TEXT,
				preferred_workflow_id TEXT,
				created_by_task_id TEXT,
				result TEXT,
				depends_on TEXT NOT NULL DEFAULT '[]',
				active_session TEXT
					CHECK(active_session IN ('worker', 'leader')),
				task_agent_session_id TEXT,
				approval_source TEXT,
				approval_reason TEXT,
				approved_at INTEGER,
				block_reason TEXT,
				archived_at INTEGER,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
				FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL
			)
		`);

    db.exec(`
			INSERT INTO space_tasks_m84_new
			  (id, space_id, task_number, title, description, status, priority, labels,
			   workflow_run_id, preferred_workflow_id, created_by_task_id, result, depends_on,
			   active_session, task_agent_session_id,
			   approval_source, approval_reason, approved_at, block_reason,
			   archived_at, created_at, started_at, completed_at, updated_at)
			SELECT
			  id, space_id, task_number, title, description, status, priority, labels,
			  workflow_run_id, preferred_workflow_id, created_by_task_id, result, depends_on,
			  active_session, task_agent_session_id,
			  approval_source, approval_reason, approved_at, block_reason,
			  archived_at, created_at, started_at, completed_at, updated_at
			FROM space_tasks
		`);

    db.exec(`DROP TABLE space_tasks`);
    db.exec(`ALTER TABLE space_tasks_m84_new RENAME TO space_tasks`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_space_id ON space_tasks(space_id)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_tasks_workflow_run_id ON space_tasks(workflow_run_id)`
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_space_tasks_task_number ON space_tasks(space_id, task_number)`
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function runMigration85(db: BunDatabase): void {
  if (!tableExists(db, 'spaces')) return;
  if (tableHasColumn(db, 'spaces', 'paused')) return;
  db.exec(`ALTER TABLE spaces ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`);
}

export function runMigration86(db: BunDatabase): void {
  if (!tableExists(db, 'spaces')) return;

  let spacesAlreadyNumeric = false;
  try {
    const row = db.prepare(`SELECT typeof(autonomy_level) as t FROM spaces LIMIT 1`).get() as
      | { t: string }
      | undefined;
    if (row && row.t === 'integer') spacesAlreadyNumeric = true;
  } catch {}

  if (!spacesAlreadyNumeric) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
				CREATE TABLE spaces_m86_new (
					id TEXT PRIMARY KEY,
					slug TEXT NOT NULL,
					workspace_path TEXT NOT NULL UNIQUE,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					background_context TEXT NOT NULL DEFAULT '',
					instructions TEXT NOT NULL DEFAULT '',
					default_model TEXT,
					allowed_models TEXT NOT NULL DEFAULT '[]',
					session_ids TEXT NOT NULL DEFAULT '[]',
					status TEXT NOT NULL DEFAULT 'active'
						CHECK(status IN ('active', 'archived')),
					autonomy_level INTEGER NOT NULL DEFAULT 1
						CHECK(autonomy_level BETWEEN 1 AND 5),
					config TEXT,
					paused INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`);
      db.exec(`
				INSERT INTO spaces_m86_new (id, slug, workspace_path, name, description,
					background_context, instructions, default_model, allowed_models,
					session_ids, status, autonomy_level, config, paused, created_at, updated_at)
				SELECT id, slug, workspace_path, name, description,
					background_context, instructions, default_model, allowed_models,
					session_ids, status,
					CASE autonomy_level
						WHEN 'semi_autonomous' THEN 3
						ELSE 1
					END,
					config, paused, created_at, updated_at
				FROM spaces
			`);
      db.exec(`DROP TABLE spaces`);
      db.exec(`ALTER TABLE spaces_m86_new RENAME TO spaces`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_slug ON spaces(slug)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status)`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  if (tableExists(db, 'space_tasks')) {
    const taskSql = tableCreateSql(db, 'space_tasks') ?? '';
    const completionActionAlreadyRemoved =
      taskSql.includes("'task_completion'") && !taskSql.includes("'completion_action'");
    if (
      !tableHasColumn(db, 'space_tasks', 'pending_action_index') &&
      !completionActionAlreadyRemoved
    ) {
      db.exec(`ALTER TABLE space_tasks ADD COLUMN pending_action_index INTEGER DEFAULT NULL`);
    }
    if (!tableHasColumn(db, 'space_tasks', 'pending_checkpoint_type')) {
      db.exec(
        `ALTER TABLE space_tasks ADD COLUMN pending_checkpoint_type TEXT DEFAULT NULL` +
          ` CHECK(pending_checkpoint_type IN ('completion_action', 'gate'))`
      );
    }

    db.exec(`
			UPDATE space_tasks SET approval_source = 'agent'
			WHERE approval_source IN ('neo_agent', 'space_agent', 'task_agent', 'node_agent')
		`);
    db.exec(`
			UPDATE space_tasks SET approval_source = 'auto_policy'
			WHERE approval_source = 'semi_auto'
		`);
  }
}

function runMigration87(db: BunDatabase): void {
  if (!tableExists(db, 'spaces')) return;
  if (tableHasColumn(db, 'spaces', 'stopped')) return;
  db.exec(`ALTER TABLE spaces ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0`);
}

function runMigration88(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;

  if (!tableHasColumn(db, 'space_tasks', 'reported_status')) {
    db.exec(
      `ALTER TABLE space_tasks ADD COLUMN reported_status TEXT DEFAULT NULL ` +
        `CHECK(reported_status IS NULL OR reported_status IN ('done', 'blocked', 'cancelled'))`
    );
  }
  if (!tableHasColumn(db, 'space_tasks', 'reported_summary')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN reported_summary TEXT DEFAULT NULL`);
  }
}

export function runMigration89(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflows')) return;
  if (!tableHasColumn(db, 'space_workflows', 'gates')) return;

  const rows = db
    .prepare(
      `SELECT id, gates FROM space_workflows ` +
        `WHERE gates IS NOT NULL AND (gates LIKE '%"human"%' OR gates LIKE '%"reviewer"%')`
    )
    .all() as { id: string; gates: string }[];

  const update = db.prepare(`UPDATE space_workflows SET gates = ? WHERE id = ?`);

  for (const row of rows) {
    let gates: unknown;
    try {
      gates = JSON.parse(row.gates);
    } catch {
      continue;
    }
    if (!Array.isArray(gates)) continue;

    let changed = false;
    for (const gate of gates) {
      if (!gate || typeof gate !== 'object') continue;
      const fields = (gate as { fields?: unknown }).fields;
      if (!Array.isArray(fields)) continue;
      for (const field of fields) {
        if (
          !field ||
          typeof field !== 'object' ||
          (field as { name?: unknown }).name !== 'approved'
        ) {
          continue;
        }
        const writers = (field as { writers?: unknown }).writers;
        if (!Array.isArray(writers)) continue;
        const filtered = writers.filter((w) => w !== 'human' && w !== 'reviewer');
        if (filtered.length !== writers.length) {
          (field as { writers: unknown[] }).writers = filtered;
          changed = true;
        }
      }
    }

    if (changed) {
      update.run(JSON.stringify(gates), row.id);
    }
  }
}

function runMigration90(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflows')) return;

  if (!tableHasColumn(db, 'space_workflows', 'template_name')) {
    db.exec(`ALTER TABLE space_workflows ADD COLUMN template_name TEXT DEFAULT NULL`);
  }
  if (!tableHasColumn(db, 'space_workflows', 'template_hash')) {
    db.exec(`ALTER TABLE space_workflows ADD COLUMN template_hash TEXT DEFAULT NULL`);
  }
}

function runMigration91(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflows')) return;

  if (!tableHasColumn(db, 'space_workflows', 'instructions')) {
    db.exec(`ALTER TABLE space_workflows ADD COLUMN instructions TEXT DEFAULT NULL`);
  }
}

export function runMigration92(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflow_runs')) return;
  if (tableExists(db, 'pending_agent_messages')) return;

  db.exec(`
		CREATE TABLE pending_agent_messages (
			id TEXT PRIMARY KEY,
			workflow_run_id TEXT NOT NULL,
			space_id TEXT NOT NULL,
			task_id TEXT,
			source_agent_name TEXT NOT NULL DEFAULT 'task-agent',
			target_kind TEXT NOT NULL
				CHECK(target_kind IN ('node_agent', 'space_agent')),
			target_agent_name TEXT NOT NULL,
			message TEXT NOT NULL,
			idempotency_key TEXT,
			attempts INTEGER NOT NULL DEFAULT 0,
			max_attempts INTEGER NOT NULL DEFAULT 5,
			last_attempt_at INTEGER,
			last_error TEXT,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'delivered', 'expired', 'failed')),
			delivered_at INTEGER,
			delivered_session_id TEXT,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_pending_agent_messages_run_status ` +
      `ON pending_agent_messages(workflow_run_id, status, created_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_pending_agent_messages_run_target ` +
      `ON pending_agent_messages(workflow_run_id, target_agent_name, status, created_at)`
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_agent_messages_idem ` +
      `ON pending_agent_messages(workflow_run_id, target_agent_name, idempotency_key) ` +
      `WHERE idempotency_key IS NOT NULL`
  );
}

export function runMigration93(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) return;
  try {
    db.prepare('SELECT sdk_origin_path FROM sessions LIMIT 1').all();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN sdk_origin_path TEXT');
  }
}

export function runMigration95(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflow_runs')) return;
  if (!tableHasColumn(db, 'space_workflow_runs', 'completion_actions_fired_at')) {
    db.exec(
      `ALTER TABLE space_workflow_runs ADD COLUMN completion_actions_fired_at INTEGER DEFAULT NULL`
    );
  }
}

export function runMigration98(db: BunDatabase): void {
  if (tableExists(db, 'workflow_run_artifact_cache')) return;

  db.exec(`
		CREATE TABLE workflow_run_artifact_cache (
			id TEXT PRIMARY KEY NOT NULL,
			run_id TEXT NOT NULL,
			task_id TEXT NOT NULL DEFAULT '',
			cache_key TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'ok'
				CHECK(status IN ('ok', 'syncing', 'error')),
			data TEXT NOT NULL DEFAULT '{}',
			error TEXT,
			synced_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(run_id, task_id, cache_key),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_wrac_run_task ON workflow_run_artifact_cache(run_id, task_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_wrac_run_task_key ON workflow_run_artifact_cache(run_id, task_id, cache_key)`
  );
}

export function runMigration99(db: BunDatabase): void {
  if (
    tableExists(db, 'space_workflows') &&
    !tableHasColumn(db, 'space_workflows', 'completion_autonomy_level')
  ) {
    db.exec(
      `ALTER TABLE space_workflows ADD COLUMN completion_autonomy_level INTEGER NOT NULL DEFAULT 3`
    );
    const perTemplateLevels: Array<[string, number]> = [
      ['Coding Workflow', 3],
      ['Research Workflow', 2],
      ['Review-Only Workflow', 2],
      ['Coding with QA Workflow', 4],
      ['Plan & Decompose Workflow', 3],
    ];
    const update = db.prepare(
      `UPDATE space_workflows SET completion_autonomy_level = ? WHERE name = ?`
    );
    for (const [name, level] of perTemplateLevels) {
      update.run(level, name);
    }
  }

  if (tableExists(db, 'space_tasks')) {
    if (!tableHasColumn(db, 'space_tasks', 'pending_completion_submitted_by_node_id')) {
      db.exec(
        `ALTER TABLE space_tasks ADD COLUMN pending_completion_submitted_by_node_id TEXT DEFAULT NULL`
      );
    }
    if (!tableHasColumn(db, 'space_tasks', 'pending_completion_submitted_at')) {
      db.exec(
        `ALTER TABLE space_tasks ADD COLUMN pending_completion_submitted_at INTEGER DEFAULT NULL`
      );
    }
    if (!tableHasColumn(db, 'space_tasks', 'pending_completion_reason')) {
      db.exec(`ALTER TABLE space_tasks ADD COLUMN pending_completion_reason TEXT DEFAULT NULL`);
    }
  }

  if (tableExists(db, 'space_tasks') && tableExists(db, 'spaces')) {
    db.exec(`
			CREATE TABLE IF NOT EXISTS space_task_report_results (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				space_id TEXT NOT NULL,
				workflow_node_id TEXT,
				agent_name TEXT,
				summary TEXT NOT NULL,
				evidence TEXT,
				recorded_at INTEGER NOT NULL,
				FOREIGN KEY (task_id) REFERENCES space_tasks(id) ON DELETE CASCADE,
				FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
			)
		`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_task_report_results_task ON space_task_report_results(task_id, recorded_at)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_task_report_results_space ON space_task_report_results(space_id, recorded_at)`
    );
  }

  if (tableExists(db, 'space_tasks')) {
    const master = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
      .get() as { sql?: string } | undefined;
    const currentSql = master?.sql ?? '';
    if (
      currentSql &&
      !currentSql.includes("'task_completion'") &&
      tableHasColumn(db, 'space_tasks', 'pending_checkpoint_type')
    ) {
      const fullColumnList = [
        'id',
        'space_id',
        'task_number',
        'title',
        'description',
        'status',
        'priority',
        'labels',
        'workflow_run_id',
        'preferred_workflow_id',
        'created_by_task_id',
        'result',
        'depends_on',
        'active_session',
        'task_agent_session_id',
        'approval_source',
        'approval_reason',
        'approved_at',
        'block_reason',
        'archived_at',
        'created_at',
        'started_at',
        'completed_at',
        'updated_at',
        'pending_action_index',
        'pending_checkpoint_type',
        'reported_status',
        'reported_summary',
        'pending_completion_submitted_by_node_id',
        'pending_completion_submitted_at',
        'pending_completion_reason',
      ];
      const existingColumns = new Set(
        (db.prepare(`PRAGMA table_info('space_tasks')`).all() as Array<{ name: string }>).map(
          (r) => r.name
        )
      );
      const copyColumns = fullColumnList.filter((c) => existingColumns.has(c));
      const copyColsSql = copyColumns.join(', ');

      const existingIndexDdl = (
        db
          .prepare(
            `SELECT sql FROM sqlite_master
						 WHERE type='index' AND tbl_name='space_tasks' AND sql IS NOT NULL`
          )
          .all() as Array<{ sql: string }>
      )
        .map((r) => r.sql)
        .filter((sql) => !!sql);

      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN');
      try {
        db.exec(`
					CREATE TABLE space_tasks_m98_new (
						id TEXT PRIMARY KEY,
						space_id TEXT NOT NULL,
						task_number INTEGER NOT NULL,
						title TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '',
						status TEXT NOT NULL DEFAULT 'open'
							CHECK(status IN ('open', 'in_progress', 'review', 'done', 'blocked', 'cancelled', 'archived')),
						priority TEXT NOT NULL DEFAULT 'normal'
							CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
						labels TEXT NOT NULL DEFAULT '[]',
						workflow_run_id TEXT,
						preferred_workflow_id TEXT,
						created_by_task_id TEXT,
						result TEXT,
						depends_on TEXT NOT NULL DEFAULT '[]',
						active_session TEXT
							CHECK(active_session IN ('worker', 'leader')),
						task_agent_session_id TEXT,
						approval_source TEXT,
						approval_reason TEXT,
						approved_at INTEGER,
						block_reason TEXT,
						archived_at INTEGER,
						created_at INTEGER NOT NULL,
						started_at INTEGER,
						completed_at INTEGER,
						updated_at INTEGER NOT NULL,
						pending_action_index INTEGER DEFAULT NULL,
						pending_checkpoint_type TEXT DEFAULT NULL
							CHECK(pending_checkpoint_type IN ('completion_action', 'gate', 'task_completion')),
						reported_status TEXT DEFAULT NULL
							CHECK(reported_status IS NULL OR reported_status IN ('done', 'blocked', 'cancelled')),
						reported_summary TEXT DEFAULT NULL,
						pending_completion_submitted_by_node_id TEXT DEFAULT NULL,
						pending_completion_submitted_at INTEGER DEFAULT NULL,
						pending_completion_reason TEXT DEFAULT NULL,
						FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
						FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE SET NULL
					)
				`);
        db.exec(
          `INSERT INTO space_tasks_m98_new (${copyColsSql}) SELECT ${copyColsSql} FROM space_tasks`
        );
        db.exec(`DROP TABLE space_tasks`);
        db.exec(`ALTER TABLE space_tasks_m98_new RENAME TO space_tasks`);
        for (const ddl of existingIndexDdl) {
          const normalized = ddl.replace(
            /^CREATE (UNIQUE )?INDEX /i,
            (_m, unique) => `CREATE ${unique ?? ''}INDEX IF NOT EXISTS `
          );
          db.exec(normalized);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }
}

export function runMigration100(db: BunDatabase): void {
  if (!tableExists(db, 'app_mcp_servers')) {
    return;
  }

  if (!tableHasColumn(db, 'app_mcp_servers', 'source')) {
    db.exec(`ALTER TABLE app_mcp_servers ADD COLUMN source TEXT`);

    const builtinSeedNames = ['fetch-mcp', 'chrome-devtools'];
    const placeholders = builtinSeedNames.map(() => '?').join(', ');
    db.prepare(
      `UPDATE app_mcp_servers SET source = 'builtin' WHERE name IN (${placeholders}) AND source IS NULL`
    ).run(...builtinSeedNames);

    db.exec(`UPDATE app_mcp_servers SET source = 'user' WHERE source IS NULL`);
  }

  if (!tableHasColumn(db, 'app_mcp_servers', 'source_path')) {
    db.exec(`ALTER TABLE app_mcp_servers ADD COLUMN source_path TEXT`);
  }

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_app_mcp_servers_import
		 ON app_mcp_servers(source_path, name)
		 WHERE source = 'imported' AND source_path IS NOT NULL`
  );
}

export function runMigration101(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS mcp_enablement (
			server_id  TEXT NOT NULL REFERENCES app_mcp_servers(id) ON DELETE CASCADE,
			scope_type TEXT NOT NULL CHECK (scope_type IN ('space', 'room', 'session')),
			scope_id   TEXT NOT NULL,
			enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
			PRIMARY KEY (server_id, scope_type, scope_id)
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_mcp_enablement_scope ON mcp_enablement(scope_type, scope_id)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_enablement_server ON mcp_enablement(server_id)`);

  if (tableExists(db, 'room_mcp_enablement')) {
    const rows = db
      .prepare(`SELECT room_id, server_id, enabled FROM room_mcp_enablement`)
      .all() as Array<{ room_id: string; server_id: string; enabled: number }>;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO mcp_enablement
				(server_id, scope_type, scope_id, enabled)
			 VALUES (?, 'room', ?, ?)`
    );
    for (const row of rows) {
      insert.run(row.server_id, row.room_id, row.enabled ? 1 : 0);
    }
  }

  if (
    tableExists(db, 'global_settings') &&
    tableExists(db, 'spaces') &&
    tableExists(db, 'app_mcp_servers')
  ) {
    try {
      const settingsRow = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as
        | { settings?: string }
        | undefined;
      const raw = settingsRow?.settings ?? '{}';
      const parsed = JSON.parse(raw) as { disabledMcpServers?: unknown };
      const disabledNames = Array.isArray(parsed.disabledMcpServers)
        ? (parsed.disabledMcpServers.filter(
            (n) => typeof n === 'string' && n.length > 0
          ) as string[])
        : [];

      if (disabledNames.length > 0) {
        const spaceRows = db
          .prepare(`SELECT id FROM spaces WHERE status = 'active'`)
          .all() as Array<{ id: string }>;

        const serverByName = db.prepare(`SELECT id FROM app_mcp_servers WHERE name = ?`);
        const insert = db.prepare(
          `INSERT OR IGNORE INTO mcp_enablement
						(server_id, scope_type, scope_id, enabled)
					 VALUES (?, 'space', ?, 0)`
        );

        for (const { id: spaceId } of spaceRows) {
          for (const name of disabledNames) {
            const srv = serverByName.get(name) as { id?: string } | undefined;
            if (!srv?.id) continue;
            insert.run(srv.id, spaceId);
          }
        }
      }
    } catch {}
  }

  if (tableExists(db, 'sessions') && tableExists(db, 'app_mcp_servers')) {
    const sessionRows = db.prepare(`SELECT id, config FROM sessions`).all() as Array<{
      id: string;
      config: string;
    }>;

    const serverByName = db.prepare(`SELECT id FROM app_mcp_servers WHERE name = ?`);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO mcp_enablement
				(server_id, scope_type, scope_id, enabled)
			 VALUES (?, 'session', ?, 0)`
    );

    for (const row of sessionRows) {
      let disabledNames: string[] = [];
      try {
        const cfg = JSON.parse(row.config ?? '{}') as {
          tools?: { disabledMcpServers?: unknown };
          disabledMcpServers?: unknown;
        };
        const candidate = cfg.tools?.disabledMcpServers ?? cfg.disabledMcpServers;
        if (Array.isArray(candidate)) {
          disabledNames = candidate.filter(
            (n): n is string => typeof n === 'string' && n.length > 0
          );
        }
      } catch {
        continue;
      }

      for (const name of disabledNames) {
        const srv = serverByName.get(name) as { id?: string } | undefined;
        if (!srv?.id) continue;
        insert.run(srv.id, row.id);
      }
    }
  }
}

export function runMigration102(db: BunDatabase): void {
  if (!tableExists(db, 'global_settings')) {
    return;
  }
  try {
    const row = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as
      | { settings: string }
      | undefined;
    if (!row) return;

    const settings = JSON.parse(row.settings) as Record<string, unknown>;
    const legacyKeys = [
      'disabledMcpServers',
      'mcpServerSettings',
      'enabledMcpServers',
      'enableAllProjectMcpServers',
    ] as const;

    let mutated = false;
    for (const key of legacyKeys) {
      if (key in settings) {
        delete settings[key];
        mutated = true;
      }
    }
    if (!mutated) return;

    db.prepare(
      `UPDATE global_settings SET settings = ?, updated_at = datetime('now') WHERE id = 1`
    ).run(JSON.stringify(settings));
  } catch {}
}

export function runMigration103(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) {
    return;
  }

  const master = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
    .get() as { sql?: string } | undefined;
  const currentSql = master?.sql ?? '';

  const hasApprovedInCheck =
    currentSql.includes('status IN (') && /status\s+IN\s*\([^)]*'approved'/.test(currentSql);

  if (currentSql && !hasApprovedInCheck) {
    const newTableSql = widenSpaceTasksApprovedStatusCheck(
      replaceCreateTableName(currentSql, 'space_tasks_m103_new')
    );
    const copyColumns = tableColumnNames(db, 'space_tasks');
    const copyColsSql = copyColumns.map(quoteSqlIdent).join(', ');
    const existingIndexDdl = capturedIndexDdl(db, 'space_tasks');

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(newTableSql);
      db.exec(
        `INSERT INTO space_tasks_m103_new (${copyColsSql}) SELECT ${copyColsSql} FROM space_tasks`
      );
      db.exec(`DROP TABLE space_tasks`);
      db.exec(`ALTER TABLE space_tasks_m103_new RENAME TO space_tasks`);
      recreateCompatibleIndexes(db, 'space_tasks', existingIndexDdl);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  if (!tableHasColumn(db, 'space_tasks', 'post_approval_session_id')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN post_approval_session_id TEXT DEFAULT NULL`);
  }
  if (!tableHasColumn(db, 'space_tasks', 'post_approval_started_at')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN post_approval_started_at INTEGER DEFAULT NULL`);
  }
  if (!tableHasColumn(db, 'space_tasks', 'post_approval_blocked_reason')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN post_approval_blocked_reason TEXT DEFAULT NULL`);
  }

  if (
    tableExists(db, 'space_workflows') &&
    !tableHasColumn(db, 'space_workflows', 'post_approval')
  ) {
    db.exec(`ALTER TABLE space_workflows ADD COLUMN post_approval TEXT DEFAULT NULL`);
  }
}

export function runMigration104(db: BunDatabase): void {
  if (tableExists(db, 'space_tasks')) {
    const hasCheckpointType = tableHasColumn(db, 'space_tasks', 'pending_checkpoint_type');
    const hasActionIndex = tableHasColumn(db, 'space_tasks', 'pending_action_index');
    if (hasCheckpointType && hasActionIndex) {
      db.prepare(
        `UPDATE space_tasks
				    SET pending_checkpoint_type = 'task_completion',
				        pending_action_index = NULL
				  WHERE pending_checkpoint_type = 'completion_action'`
      ).run();
    } else if (hasCheckpointType) {
      db.prepare(
        `UPDATE space_tasks
				    SET pending_checkpoint_type = 'task_completion'
				  WHERE pending_checkpoint_type = 'completion_action'`
      ).run();
    }
  }

  if (tableExists(db, 'space_tasks')) {
    const master = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
      .get() as { sql?: string } | undefined;
    const currentSql = master?.sql ?? '';

    const hasLegacyCheckpointCheck =
      currentSql.includes("pending_checkpoint_type IN ('completion_action'") ||
      /pending_checkpoint_type\s+IN\s*\([^)]*'completion_action'/.test(currentSql);
    const hasActionIndexCol = tableHasColumn(db, 'space_tasks', 'pending_action_index');
    const needsRebuild = !!currentSql && (hasLegacyCheckpointCheck || hasActionIndexCol);

    if (needsRebuild) {
      const newTableSql = tightenPendingCheckpointTypeCheck(
        createTableSqlWithoutColumn(
          replaceCreateTableName(currentSql, 'space_tasks_m104_new'),
          'pending_action_index'
        )
      );
      const copyColumns = tableColumnNames(db, 'space_tasks').filter(
        (c) => c !== 'pending_action_index'
      );
      const copyColsSql = copyColumns.map(quoteSqlIdent).join(', ');
      const existingIndexDdl = capturedIndexDdl(db, 'space_tasks');

      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN');
      try {
        db.exec(newTableSql);
        db.exec(
          `INSERT INTO space_tasks_m104_new (${copyColsSql}) SELECT ${copyColsSql} FROM space_tasks`
        );
        db.exec(`DROP TABLE space_tasks`);
        db.exec(`ALTER TABLE space_tasks_m104_new RENAME TO space_tasks`);
        recreateCompatibleIndexes(db, 'space_tasks', existingIndexDdl);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  if (
    tableExists(db, 'space_workflow_runs') &&
    tableHasColumn(db, 'space_workflow_runs', 'completion_actions_fired_at')
  ) {
    db.exec(`ALTER TABLE space_workflow_runs DROP COLUMN completion_actions_fired_at`);
  }
}

export function runMigration105(db: BunDatabase): void {
  if (!tableExists(db, 'space_agents')) return;

  if (!tableHasColumn(db, 'space_agents', 'template_name')) {
    db.exec(`ALTER TABLE space_agents ADD COLUMN template_name TEXT DEFAULT NULL`);
  }
  if (!tableHasColumn(db, 'space_agents', 'template_hash')) {
    db.exec(`ALTER TABLE space_agents ADD COLUMN template_hash TEXT DEFAULT NULL`);
  }
}

export function runMigration106(db: BunDatabase): void {
  runMigration106External(db);
}

export function runMigration170(db: BunDatabase): void {
  runMigration170External(db);
}

export function runMigration172(db: BunDatabase): void {
  runMigration172External(db);
}

export function runMigration179(db: BunDatabase): void {
  if (!tableExists(db, 'pending_agent_messages')) return;
  if (tableHasColumn(db, 'pending_agent_messages', 'workflow_node_id')) return;
  db.exec(`ALTER TABLE pending_agent_messages ADD COLUMN workflow_node_id TEXT`);
}

export function runMigration182(db: BunDatabase): void {
  if (!tableExists(db, 'job_queue')) return;
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_message_delivery_active_turn
      ON job_queue (queue, json_extract(payload, '$.sessionId'))
      WHERE queue = 'message_delivery'
        AND json_extract(payload, '$.role') = 'turn'
        AND status IN ('pending', 'processing')
  `);
}

export function runMigration183(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) return;
  const tableSql = tableCreateSql(db, 'sdk_messages');
  if (!tableSql || tableSql.includes("'submitted'")) return;

  const objects = db
    .prepare(`SELECT type, name, sql FROM sqlite_master
      WHERE tbl_name = 'sdk_messages' AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
    .all() as Array<{ type: string; name: string; sql: string }>;
  const widenedSql = tableSql
    .replace(
      /CREATE TABLE(?: IF NOT EXISTS)?\s+["'`[]?sdk_messages["'`\]]?/i,
      'CREATE TABLE sdk_messages_m182_new'
    )
    .replace(
      /CHECK\s*\(send_status IN \('deferred', 'enqueued', 'consumed', 'failed'\)\)/,
      "CHECK(send_status IN ('deferred', 'enqueued', 'submitted', 'consumed', 'failed'))"
    );
  if (widenedSql === tableSql) return;

  const columns = db.prepare(`PRAGMA table_xinfo('sdk_messages')`).all() as Array<{
    name: string;
    hidden: number;
  }>;
  const storedColumns = columns
    .filter((column) => column.hidden === 0)
    .map((column) => column.name);
  const quoted = storedColumns.map((name) => `"${name.replaceAll('"', '""')}"`).join(', ');
  const foreignKeys = (
    db.prepare(`PRAGMA foreign_keys`).get() as { foreign_keys: number } | undefined
  )?.foreign_keys;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(widenedSql);
    db.exec(`INSERT INTO sdk_messages_m182_new (${quoted}) SELECT ${quoted} FROM sdk_messages`);
    db.exec('DROP TABLE sdk_messages');
    db.exec('ALTER TABLE sdk_messages_m182_new RENAME TO sdk_messages');
    for (const object of objects) db.exec(object.sql);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys === 0 ? 'OFF' : 'ON'}`);
  }
}

export function runMigration107(db: BunDatabase): void {
  db.exec(`DROP INDEX IF EXISTS idx_space_task_report_results_task`);
  db.exec(`DROP INDEX IF EXISTS idx_space_task_report_results_space`);
  db.exec(`DROP TABLE IF EXISTS space_task_report_results`);
}

export function runMigration108(db: BunDatabase): void {
  const legacyServerNames = ['brave-search', 'web-search-brave'];
  const legacySkillNames = ['web-search-mcp', 'builtin-web-search-mcp'];

  const legacyServerIds = new Set<string>();
  if (tableExists(db, 'app_mcp_servers')) {
    const rows = db
      .prepare(
        `SELECT id, name, description, command, args, env
				   FROM app_mcp_servers`
      )
      .all() as Array<{
      id: string;
      name: string;
      description: string | null;
      command: string | null;
      args: string | null;
      env: string | null;
    }>;

    for (const row of rows) {
      const searchable = [
        row.name,
        row.description ?? '',
        row.command ?? '',
        row.args ?? '',
        row.env ?? '',
      ]
        .join('\n')
        .toLowerCase();
      if (
        legacyServerNames.includes(row.name.toLowerCase()) ||
        searchable.includes('server-brave-search') ||
        searchable.includes('brave_api_key') ||
        searchable.includes('brave search')
      ) {
        legacyServerIds.add(row.id);
      }
    }
  }

  const legacySkillIds = new Set<string>();
  if (tableExists(db, 'skills')) {
    const rows = db
      .prepare(`SELECT id, name, display_name, description, config FROM skills`)
      .all() as Array<{
      id: string;
      name: string;
      display_name: string;
      description: string;
      config: string;
    }>;

    for (const row of rows) {
      const lowerName = row.name.toLowerCase();
      const searchable = [row.name, row.display_name, row.description, row.config]
        .join('\n')
        .toLowerCase();
      const referencesLegacyServer = [...legacyServerIds].some((id) => row.config.includes(id));
      if (
        legacySkillNames.includes(lowerName) ||
        row.display_name.toLowerCase() === 'web search (mcp)' ||
        searchable.includes('brave search') ||
        searchable.includes('brave_api_key') ||
        referencesLegacyServer
      ) {
        legacySkillIds.add(row.id);
      }
    }
  }

  if (legacySkillIds.size > 0) {
    if (tableExists(db, 'room_skill_overrides')) {
      const deleteOverride = db.prepare(`DELETE FROM room_skill_overrides WHERE skill_id = ?`);
      for (const id of legacySkillIds) deleteOverride.run(id);
    }
    const deleteSkill = db.prepare(`DELETE FROM skills WHERE id = ?`);
    for (const id of legacySkillIds) deleteSkill.run(id);
  }

  if (legacyServerIds.size > 0) {
    if (tableExists(db, 'mcp_enablement')) {
      const deleteEnablement = db.prepare(`DELETE FROM mcp_enablement WHERE server_id = ?`);
      for (const id of legacyServerIds) deleteEnablement.run(id);
    }
    if (tableExists(db, 'room_mcp_enablement')) {
      const deleteRoomEnablement = db.prepare(
        `DELETE FROM room_mcp_enablement WHERE server_id = ?`
      );
      for (const id of legacyServerIds) deleteRoomEnablement.run(id);
    }
    const deleteServer = db.prepare(`DELETE FROM app_mcp_servers WHERE id = ?`);
    for (const id of legacyServerIds) deleteServer.run(id);
  }

  const legacyNames = new Set([...legacyServerNames, ...legacySkillNames]);
  if (tableExists(db, 'global_settings')) {
    try {
      const row = db.prepare(`SELECT settings FROM global_settings WHERE id = 1`).get() as
        | { settings: string }
        | undefined;
      if (row) {
        const settings = JSON.parse(row.settings) as Record<string, unknown>;
        let mutated = false;
        for (const key of ['disabledMcpServers', 'enabledMcpServers'] as const) {
          const value = settings[key];
          if (!Array.isArray(value)) continue;
          const filtered = value.filter((name) => {
            return typeof name !== 'string' || !legacyNames.has(name.toLowerCase());
          });
          if (filtered.length !== value.length) {
            settings[key] = filtered;
            mutated = true;
          }
        }
        if (mutated) {
          db.prepare(
            `UPDATE global_settings SET settings = ?, updated_at = datetime('now') WHERE id = 1`
          ).run(JSON.stringify(settings));
        }
      }
    } catch {}
  }

  if (tableExists(db, 'sessions')) {
    const rows = db.prepare(`SELECT id, config FROM sessions`).all() as Array<{
      id: string;
      config: string | null;
    }>;
    const update = db.prepare(`UPDATE sessions SET config = ? WHERE id = ?`);
    for (const row of rows) {
      try {
        const config = JSON.parse(row.config ?? '{}') as Record<string, unknown> & {
          tools?: Record<string, unknown>;
        };
        let mutated = false;
        for (const holder of [config, config.tools].filter(Boolean) as Array<
          Record<string, unknown>
        >) {
          const value = holder.disabledMcpServers;
          if (!Array.isArray(value)) continue;
          const filtered = value.filter((name) => {
            return typeof name !== 'string' || !legacyNames.has(name.toLowerCase());
          });
          if (filtered.length !== value.length) {
            holder.disabledMcpServers = filtered;
            mutated = true;
          }
        }
        if (mutated) update.run(JSON.stringify(config), row.id);
      } catch {
        continue;
      }
    }
  }
}

export function runMigration109(db: BunDatabase): void {
  if (
    tableExists(db, 'node_executions') &&
    !statusCheckContains(db, 'node_executions', 'waiting_rebind')
  ) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
				CREATE TABLE node_executions_m109_new (
					id TEXT PRIMARY KEY,
					workflow_run_id TEXT NOT NULL,
					workflow_node_id TEXT NOT NULL,
					agent_name TEXT NOT NULL,
					agent_id TEXT,
					agent_session_id TEXT,
					status TEXT NOT NULL DEFAULT 'pending'
						CHECK(status IN ('pending', 'in_progress', 'idle', 'done', 'waiting_rebind', 'blocked', 'cancelled')),
					result TEXT,
					data TEXT,
					created_at INTEGER NOT NULL,
					started_at INTEGER,
					completed_at INTEGER,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY (workflow_run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE,
					FOREIGN KEY (agent_id) REFERENCES space_agents(id) ON DELETE SET NULL
				)
			`);

      db.exec(`
				INSERT INTO node_executions_m109_new
				  (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				   agent_session_id, status, result, data, created_at, started_at,
				   completed_at, updated_at)
				SELECT
				  id, workflow_run_id, workflow_node_id, agent_name, agent_id,
				  agent_session_id, status, result,
				  ${tableHasColumn(db, 'node_executions', 'data') ? 'data' : 'NULL'},
				  created_at, started_at, completed_at, updated_at
				FROM node_executions
			`);

      db.exec(`DROP TABLE node_executions`);
      db.exec(`ALTER TABLE node_executions_m109_new RENAME TO node_executions`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_node_executions_run ON node_executions(workflow_run_id)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_node_executions_node ON node_executions(workflow_run_id, workflow_node_id)`
      );
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_node_executions_unique_slot
				 ON node_executions(workflow_run_id, workflow_node_id, agent_name)`
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  db.exec(`
		CREATE TABLE IF NOT EXISTS tool_continuation_recovery (
			tool_use_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			execution_id TEXT,
			workflow_run_id TEXT,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'waiting_rebind', 'rebound', 'failed', 'expired', 'consumed')),
			attempts_409 INTEGER NOT NULL DEFAULT 0,
			recovery_reason TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS tool_continuation_inbox (
			id TEXT PRIMARY KEY,
			tool_use_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			execution_id TEXT,
			workflow_run_id TEXT,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'rebound', 'failed', 'expired')),
			request_json TEXT NOT NULL,
			recovery_reason TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tool_continuation_recovery_session
		 ON tool_continuation_recovery(session_id, status, expires_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tool_continuation_recovery_execution
		 ON tool_continuation_recovery(execution_id, status, expires_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tool_continuation_inbox_execution
		 ON tool_continuation_inbox(execution_id, status, expires_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tool_continuation_inbox_tool
		 ON tool_continuation_inbox(tool_use_id, status, expires_at)`
  );
}

export function runMigration110(db: BunDatabase): void {
  if (!tableExists(db, 'pending_agent_messages')) return;

  db.exec('DROP INDEX IF EXISTS idx_pending_agent_messages_idem');
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_agent_messages_idem_pending
		 ON pending_agent_messages(workflow_run_id, target_agent_name, idempotency_key)
		 WHERE idempotency_key IS NOT NULL AND status = 'pending'`
  );
}

export function runMigration111(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_github_watched_repos (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			owner TEXT NOT NULL,
			repo TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			webhook_enabled INTEGER NOT NULL DEFAULT 1,
			polling_enabled INTEGER NOT NULL DEFAULT 0,
			webhook_secret TEXT,
			last_webhook_at INTEGER,
			last_poll_at INTEGER,
			poll_cursor TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(space_id, owner, repo)
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_github_events (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			task_id TEXT,
			source TEXT NOT NULL CHECK(source IN ('webhook', 'polling')),
			delivery_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			action TEXT NOT NULL,
			repo_owner TEXT NOT NULL,
			repo_name TEXT NOT NULL,
			pr_number INTEGER NOT NULL,
			pr_url TEXT NOT NULL,
			actor TEXT NOT NULL,
			actor_type TEXT NOT NULL,
			body TEXT NOT NULL DEFAULT '',
			summary TEXT NOT NULL DEFAULT '',
			external_url TEXT NOT NULL DEFAULT '',
			external_id TEXT NOT NULL DEFAULT '',
			occurred_at INTEGER NOT NULL,
			dedupe_key TEXT NOT NULL,
			raw_payload TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'received' CHECK(state IN ('received', 'processed', 'ignored', 'ambiguous', 'routed', 'delivered', 'failed')),
			matched_by TEXT,
			confidence TEXT,
			route_note TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(space_id, dedupe_key)
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_github_watched_repo_lookup ON space_github_watched_repos(owner, repo, enabled)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_github_events_task ON space_github_events(task_id, occurred_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_github_events_repo ON space_github_events(space_id, repo_owner, repo_name, pr_number)`
  );
}

export function runMigration112(db: BunDatabase): void {
  if (!tableExists(db, 'space_github_events')) return;

  db.exec(`
		DELETE FROM space_github_events
		WHERE rowid IN (
			SELECT rowid
			FROM (
				SELECT
					rowid,
					ROW_NUMBER() OVER (
						PARTITION BY space_id, lower(dedupe_key)
						ORDER BY
							CASE WHEN task_id IS NOT NULL THEN 0 ELSE 1 END,
							CASE state
								WHEN 'delivered' THEN 0
								WHEN 'routed' THEN 1
								WHEN 'processed' THEN 2
								WHEN 'ambiguous' THEN 3
								WHEN 'failed' THEN 4
								WHEN 'ignored' THEN 5
								ELSE 6
							END,
							updated_at DESC,
							occurred_at DESC,
							rowid ASC
					) AS rn
				FROM space_github_events
			)
			WHERE rn > 1
		)
	`);
  db.exec(`UPDATE space_github_events SET dedupe_key = lower(dedupe_key)`);
}

export function runMigration113(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_timestamp_id
		ON sdk_messages(session_id, timestamp DESC, id DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_uuid_status
		ON sdk_messages(session_id, send_status, json_extract(sdk_message, '$.uuid'))`);
}

export function runMigration114(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;

  const master = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
    .get() as { sql?: string } | undefined;
  const currentSql = master?.sql ?? '';
  if (!currentSql) return;

  if (statusCheckContains(db, 'space_tasks', 'draft')) return;

  const newTableSql = addDraftToStatusCheck(
    replaceCreateTableName(currentSql, 'space_tasks_m114_new')
  );
  const copyColumns = tableColumnNames(db, 'space_tasks').map(quoteSqlIdent).join(', ');
  const existingIndexDdl = capturedIndexDdl(db, 'space_tasks');

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`DROP TABLE IF EXISTS space_tasks_m114_new`);
    db.exec(newTableSql);
    db.exec(
      `INSERT INTO space_tasks_m114_new (${copyColumns}) SELECT ${copyColumns} FROM space_tasks`
    );
    db.exec(`DROP TABLE space_tasks`);
    db.exec(`ALTER TABLE space_tasks_m114_new RENAME TO space_tasks`);
    recreateCompatibleIndexes(db, 'space_tasks', existingIndexDdl);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function addDraftToStatusCheck(createSql: string): string {
  let matched = false;
  const result = createSql.replace(
    /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i,
    (match, values: string) => {
      matched = true;
      if (values.includes("'draft'")) {
        return match;
      }
      return `CHECK(status IN ('draft', ${values.trim()}))`;
    }
  );
  if (!matched) {
    throw new Error('Unable to add draft to space_tasks.status CHECK constraint');
  }
  return result;
}

export function runMigration115(db: BunDatabase): void {
  if (!tableExists(db, 'spaces')) return;

  const columns = tableColumnNames(db, 'spaces');
  if (columns.includes('task_agent_config')) return;

  db.exec(`ALTER TABLE spaces ADD COLUMN task_agent_config TEXT DEFAULT NULL`);
}

export function runMigration116(db: BunDatabase): void {
  if (!tableExists(db, 'space_agents')) return;

  const columns = tableColumnNames(db, 'space_agents');
  if (columns.includes('thinking_level')) return;

  db.exec(`ALTER TABLE space_agents ADD COLUMN thinking_level TEXT DEFAULT NULL`);
}

export function runMigration117(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflows')) return;

  const columns = tableColumnNames(db, 'space_workflows');
  if (columns.includes('disabled')) return;

  db.exec(`ALTER TABLE space_workflows ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0`);
}

export function runMigration122(db: BunDatabase): void {
  if (tableExists(db, 'sdk_messages')) {
    const columns = tableColumnNames(db, 'sdk_messages');
    const addedRenderable = !columns.includes('is_renderable');
    const addedTerminal = !columns.includes('is_terminal');
    const addedParentToolUseId = !columns.includes('parent_tool_use_id');
    const addedTaskId = !columns.includes('task_id');

    if (addedRenderable) {
      db.exec(`ALTER TABLE sdk_messages ADD COLUMN is_renderable INTEGER NOT NULL DEFAULT 1`);
    }
    if (addedTerminal) {
      db.exec(`ALTER TABLE sdk_messages ADD COLUMN is_terminal INTEGER NOT NULL DEFAULT 0`);
    }
    if (addedParentToolUseId) {
      db.exec(`ALTER TABLE sdk_messages ADD COLUMN parent_tool_use_id TEXT`);
    }
    if (addedTaskId) {
      db.exec(`ALTER TABLE sdk_messages ADD COLUMN task_id TEXT`);
    }

    db.exec(`
			UPDATE sdk_messages
			SET
				is_terminal = CASE WHEN message_type = 'result' THEN 1 ELSE 0 END,
				parent_tool_use_id = CASE
					WHEN json_valid(sdk_message)
					THEN json_extract(sdk_message, '$.parent_tool_use_id')
					ELSE NULL
				END,
				is_renderable = CASE
					WHEN NOT json_valid(sdk_message) THEN 1
					WHEN message_type = 'user'
						AND json_type(sdk_message, '$.message.content') = 'array'
						AND EXISTS (
							SELECT 1
							FROM json_each(json_extract(sdk_message, '$.message.content')) je
							WHERE json_extract(je.value, '$.type') = 'tool_result'
						)
					THEN 0
					WHEN message_type = 'assistant'
						AND json_type(sdk_message, '$.message.content') = 'array'
						AND NOT EXISTS (
							SELECT 1
							FROM json_each(json_extract(sdk_message, '$.message.content')) je
							WHERE json_extract(je.value, '$.type') = 'tool_use'
								OR (
									json_extract(je.value, '$.type') = 'text'
									AND TRIM(COALESCE(json_extract(je.value, '$.text'), '')) != ''
								)
								OR (
									json_extract(je.value, '$.type') = 'thinking'
									AND TRIM(COALESCE(json_extract(je.value, '$.thinking'), '')) != ''
								)
						)
					THEN 0
					ELSE 1
				END
			WHERE
				-- is_terminal mismatch
				is_terminal != CASE WHEN message_type = 'result' THEN 1 ELSE 0 END
				OR
				-- parent_tool_use_id should be non-NULL but is NULL
				(
					json_valid(sdk_message)
					AND json_extract(sdk_message, '$.parent_tool_use_id') IS NOT NULL
					AND parent_tool_use_id IS NULL
				)
				OR
				-- parent_tool_use_id should be NULL but is non-NULL
				(
					parent_tool_use_id IS NOT NULL
					AND (
						NOT json_valid(sdk_message)
						OR json_extract(sdk_message, '$.parent_tool_use_id') IS NULL
					)
				)
				OR
				-- is_renderable mismatch for user/assistant messages
				(
					message_type IN ('user', 'assistant')
					AND is_renderable != CASE
						WHEN message_type = 'user'
							AND json_type(sdk_message, '$.message.content') = 'array'
							AND EXISTS (
								SELECT 1
								FROM json_each(json_extract(sdk_message, '$.message.content')) je
								WHERE json_extract(je.value, '$.type') = 'tool_result'
							)
						THEN 0
						WHEN message_type = 'assistant'
							AND json_type(sdk_message, '$.message.content') = 'array'
							AND NOT EXISTS (
								SELECT 1
								FROM json_each(json_extract(sdk_message, '$.message.content')) je
								WHERE json_extract(je.value, '$.type') = 'tool_use'
									OR (
										json_extract(je.value, '$.type') = 'text'
										AND TRIM(COALESCE(json_extract(je.value, '$.text'), '')) != ''
									)
									OR (
										json_extract(je.value, '$.type') = 'thinking'
										AND TRIM(COALESCE(json_extract(je.value, '$.thinking'), '')) != ''
									)
							)
						THEN 0
						ELSE 1
					END
				)
		`);

    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_parent_tool_use_id ON sdk_messages(session_id, parent_tool_use_id)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_renderable_terminal ON sdk_messages(session_id, is_renderable, is_terminal, timestamp, id)`
    );

    if (tableExists(db, 'sessions')) {
      db.exec(`
				UPDATE sdk_messages
				SET task_id = (
					SELECT
						CASE
							WHEN s.session_context IS NULL THEN NULL
							WHEN NOT json_valid(s.session_context) THEN NULL
							ELSE json_extract(s.session_context, '$.taskId')
						END
					FROM sessions s
					WHERE s.id = sdk_messages.session_id
					  AND s.type IN ('space_task_agent', 'worker')
				)
				WHERE task_id IS NULL
				  AND session_id IN (
					  SELECT id FROM sessions
					  WHERE type IN ('space_task_agent', 'worker')
						AND session_context IS NOT NULL
						AND json_valid(session_context)
						AND json_extract(session_context, '$.taskId') IS NOT NULL
				  )
			`);
    }

    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id ON sdk_messages(task_id, timestamp)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_session ON sdk_messages(task_id, session_id)`
    );
  }

  db.exec(`DROP TABLE IF EXISTS task_session_map`);
}

export function runMigration118(db: BunDatabase): void {
  if (!tableExists(db, 'space_agents')) return;

  const columns = tableColumnNames(db, 'space_agents');
  if (columns.includes('setting_sources')) return;

  db.exec(`ALTER TABLE space_agents ADD COLUMN setting_sources TEXT DEFAULT NULL`);
}

export function runMigration119(db: BunDatabase): void {
  if (!tableExists(db, 'spaces')) return;

  const columns = tableColumnNames(db, 'spaces');
  if (columns.includes('setting_sources')) return;

  db.exec(`ALTER TABLE spaces ADD COLUMN setting_sources TEXT DEFAULT NULL`);
}

export function runMigration120(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;

  const columns = tableColumnNames(db, 'space_tasks');
  if (!columns.includes('created_by')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN created_by TEXT DEFAULT NULL`);
  }
  if (!columns.includes('created_by_session')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN created_by_session TEXT DEFAULT NULL`);
  }
}

export function runMigration121(db: BunDatabase): void {
  if (!tableExists(db, 'mcp_audit_log')) {
    db.exec(`
			CREATE TABLE mcp_audit_log (
				id TEXT PRIMARY KEY,
				timestamp INTEGER NOT NULL,
				agent_name TEXT DEFAULT NULL,
				session_id TEXT DEFAULT NULL,
				tool_name TEXT NOT NULL,
				params_summary TEXT DEFAULT NULL,
				space_id TEXT DEFAULT NULL,
				task_id TEXT DEFAULT NULL,
				workflow_run_id TEXT DEFAULT NULL
			)
		`);
  }

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_space ON mcp_audit_log (space_id, timestamp)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_task ON mcp_audit_log (task_id, timestamp)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_session ON mcp_audit_log (session_id, timestamp)`
  );
}

export function runMigration123(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_external_events (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			source TEXT NOT NULL,
			topic TEXT NOT NULL,
			dedupe_key TEXT NOT NULL,
			occurred_at INTEGER NOT NULL,
			ingested_at INTEGER NOT NULL,
			source_event_id TEXT,
			pr_number INTEGER,
			repo_owner TEXT,
			repo_name TEXT,
			branch TEXT,
			summary TEXT NOT NULL,
			external_url TEXT,
			payload_json TEXT NOT NULL,
			routed_task_id TEXT,
			state TEXT NOT NULL DEFAULT 'published'
				CHECK(state IN ('published', 'routed', 'delivered', 'delivery_failed', 'failed', 'ignored', 'ambiguous')),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(space_id, source, dedupe_key),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);

  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_space_external_events_lookup
		ON space_external_events(space_id, source, dedupe_key)
	`);

  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_space_external_events_state
		ON space_external_events(state, updated_at)
	`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_external_event_deliveries (
			event_id TEXT NOT NULL,
			delivery_key TEXT NOT NULL,
			workflow_run_id TEXT NOT NULL,
			task_id TEXT NOT NULL,
			node_id TEXT NOT NULL,
			agent_name TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'pending'
				CHECK(state IN ('pending', 'delivered', 'failed')),
			failure_reason TEXT,
			delivered_at INTEGER,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(event_id, delivery_key),
			FOREIGN KEY (event_id) REFERENCES space_external_events(id) ON DELETE CASCADE
		)
	`);

  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_space_external_event_deliveries_event
		ON space_external_event_deliveries(event_id, state)
	`);

  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_space_external_event_deliveries_run
		ON space_external_event_deliveries(workflow_run_id, state)
	`);

  db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_space_external_event_deliveries_key
		ON space_external_event_deliveries(delivery_key)
	`);
}

export function runMigration124(db: BunDatabase): void {
  const hasOldTable = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='space_external_events'`)
    .get();
  const hasNewTable = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='space_external_events_new'`)
    .get();
  if (hasNewTable) {
    if (!hasOldTable) {
      db.exec(`ALTER TABLE space_external_events_new RENAME TO space_external_events`);
    } else {
      const oldCount = db.prepare(`SELECT COUNT(*) AS n FROM space_external_events`).get() as {
        n: number;
      };
      const newCount = db.prepare(`SELECT COUNT(*) AS n FROM space_external_events_new`).get() as {
        n: number;
      };
      if (newCount.n > 0 && oldCount.n === 0) {
        db.exec(`DROP TABLE space_external_events`);
        db.exec(`ALTER TABLE space_external_events_new RENAME TO space_external_events`);
      } else if (oldCount.n > 0 && newCount.n > 0) {
        db.exec(`DROP TABLE space_external_events_new`);
      }
    }
  }

  const hasOldSchema = db
    .prepare(`SELECT 1 FROM pragma_table_info('space_external_events') WHERE name = 'pr_number'`)
    .get();
  if (!hasOldSchema) {
    return;
  }

  db.exec(`DROP TABLE IF EXISTS space_external_events_new`);

  const originalFk = db.prepare(`PRAGMA foreign_keys`).get() as
    | { foreign_keys: number }
    | undefined;
  const fkWasOn = originalFk ? originalFk.foreign_keys === 1 : true;

  db.exec(`PRAGMA foreign_keys = OFF`);

  try {
    db.transaction(() => {
      db.exec(`
				UPDATE space_external_events
				SET payload_json = '{}'
				WHERE json_valid(payload_json) = 0
				   OR json_type(payload_json) != 'object'
			`);
      db.exec(`
				UPDATE space_external_events
				SET payload_json = json_set(
					payload_json,
					'$.prNumber', COALESCE(json_extract(payload_json, '$.prNumber'), pr_number),
					'$.repoOwner', COALESCE(json_extract(payload_json, '$.repoOwner'), NULLIF(repo_owner, '')),
					'$.repoName', COALESCE(json_extract(payload_json, '$.repoName'), NULLIF(repo_name, '')),
					'$.branch', COALESCE(json_extract(payload_json, '$.branch'), NULLIF(branch, ''))
				)
				WHERE json_valid(payload_json) = 1
				  AND json_type(payload_json) = 'object'
				  AND (pr_number IS NOT NULL
				   OR NULLIF(repo_owner, '') IS NOT NULL
				   OR NULLIF(repo_name, '') IS NOT NULL
				   OR NULLIF(branch, '') IS NOT NULL)
			`);

      db.exec(`
				UPDATE space_external_events
				SET payload_json = json_set(
					payload_json,
					'$.routedTaskId', COALESCE(json_extract(payload_json, '$.routedTaskId'), routed_task_id)
				)
				WHERE json_valid(payload_json) = 1
				  AND json_type(payload_json) = 'object'
				  AND routed_task_id IS NOT NULL
			`);

      db.exec(`
				UPDATE space_external_events
				SET state = CASE state
					WHEN 'routed' THEN 'published'
					WHEN 'delivery_failed' THEN 'published'
					WHEN 'ambiguous' THEN 'ignored'
					ELSE state
				END
				WHERE state IN ('routed', 'delivery_failed', 'ambiguous')
			`);

      db.exec(`
				CREATE TABLE space_external_events_new (
					id TEXT PRIMARY KEY,
					space_id TEXT NOT NULL,
					source TEXT NOT NULL,
					topic TEXT NOT NULL,
					dedupe_key TEXT NOT NULL,
					occurred_at INTEGER NOT NULL,
					ingested_at INTEGER NOT NULL,
					source_event_id TEXT,
					summary TEXT NOT NULL,
					external_url TEXT,
					payload_json TEXT NOT NULL,
					state TEXT NOT NULL DEFAULT 'published'
						CHECK(state IN ('published', 'delivered', 'failed', 'ignored')),
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					UNIQUE(space_id, source, dedupe_key),
					FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
				)
			`);

      db.exec(`
				INSERT INTO space_external_events_new (
					id, space_id, source, topic, dedupe_key,
					occurred_at, ingested_at, source_event_id,
					summary, external_url, payload_json,
					state, created_at, updated_at
				)
				SELECT
					id, space_id, source, topic, dedupe_key,
					occurred_at, ingested_at, source_event_id,
					summary, external_url, payload_json,
					state, created_at, updated_at
				FROM space_external_events
			`);

      db.exec(`DROP TABLE space_external_events`);
      db.exec(`ALTER TABLE space_external_events_new RENAME TO space_external_events`);

      db.exec(`
				CREATE INDEX IF NOT EXISTS idx_space_external_events_lookup
				ON space_external_events(space_id, source, dedupe_key)
			`);
      db.exec(`
				CREATE INDEX IF NOT EXISTS idx_space_external_events_state
				ON space_external_events(state, updated_at)
			`);
    })();
  } finally {
    db.exec(`PRAGMA foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);
  }
}

export function runMigration125(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS task_schedules (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			preferred_workflow_id TEXT DEFAULT NULL,
			labels TEXT NOT NULL DEFAULT '[]',
			metadata_json TEXT NOT NULL DEFAULT '{}',
			trigger_type TEXT NOT NULL CHECK(trigger_type IN ('cron', 'at')),
			cron_expression TEXT DEFAULT NULL,
			run_at INTEGER DEFAULT NULL,
			timezone TEXT NOT NULL DEFAULT 'UTC',
			next_run_at INTEGER DEFAULT NULL,
			last_run_at INTEGER DEFAULT NULL,
			last_created_task_id TEXT DEFAULT NULL,
			pending_job_id TEXT DEFAULT NULL,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'paused', 'completed')),
			created_by_agent TEXT DEFAULT NULL,
			created_by_session TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);

  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_task_schedules_space
		ON task_schedules(space_id, status)
	`);

  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_task_schedules_active_due
		ON task_schedules(status, next_run_at)
		WHERE status = 'active'
	`);

  const columns = db.prepare(`PRAGMA table_info(space_tasks)`).all() as { name: string }[];
  if (columns.length > 0 && !columns.some((c) => c.name === 'created_by_task_schedule_id')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN created_by_task_schedule_id TEXT DEFAULT NULL`);
  }
}

export function runMigration126(db: BunDatabase): void {
  db.exec(`DROP INDEX IF EXISTS idx_sdk_messages_parent_tool`);
}

export function runMigration127(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflows')) return;

  const columns = tableColumnNames(db, 'space_workflows');
  const columnJustAdded = !columns.includes('handle');
  if (columnJustAdded) {
    db.exec(`ALTER TABLE space_workflows ADD COLUMN handle TEXT DEFAULT NULL`);
  }

  db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_space_workflows_handle
		ON space_workflows(space_id, handle)
		WHERE handle IS NOT NULL
	`);

  interface WorkflowRow {
    id: string;
    space_id: string;
    name: string;
  }
  const rows = db
    .prepare(`SELECT id, space_id, name FROM space_workflows WHERE handle IS NULL`)
    .all() as WorkflowRow[];
  if (rows.length === 0) return;

  interface ExistingHandleRow {
    space_id: string;
    handle: string;
  }
  const existingHandleRows = db
    .prepare(`SELECT space_id, handle FROM space_workflows WHERE handle IS NOT NULL`)
    .all() as ExistingHandleRow[];
  const spaceHandles = new Map<string, string[]>();
  for (const row of existingHandleRows) {
    const handles = spaceHandles.get(row.space_id) ?? [];
    handles.push(row.handle);
    spaceHandles.set(row.space_id, handles);
  }

  const updateStmt = db.prepare(`UPDATE space_workflows SET handle = ? WHERE id = ?`);
  for (const row of rows) {
    const handles = spaceHandles.get(row.space_id) ?? [];
    const handle = generateValidHandle(row.name, handles);
    updateStmt.run(handle, row.id);
    handles.push(handle);
    spaceHandles.set(row.space_id, handles);
  }
}

export function runMigration128(db: BunDatabase): void {
  const hadLegacyGlobalConfigTable = tableExists(db, 'external_event_source_configs');

  db.exec(`
		CREATE TABLE IF NOT EXISTS external_event_extension_configs (
			source TEXT PRIMARY KEY,
			globally_enabled INTEGER NOT NULL DEFAULT 0 CHECK(globally_enabled IN (0, 1)),
			capabilities_json TEXT NOT NULL DEFAULT '{}',
			secrets_ref TEXT DEFAULT NULL,
			settings_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

  if (hadLegacyGlobalConfigTable) {
    db.exec(`
			INSERT OR IGNORE INTO external_event_extension_configs (
				source, globally_enabled, capabilities_json, secrets_ref,
				settings_json, created_at, updated_at
			)
			SELECT
				source,
				globally_enabled,
				json_set(
						CASE
							WHEN json_valid(capabilities_json) AND json_type(capabilities_json) = 'object'
								THEN capabilities_json
							ELSE '{}'
						END,
						'$.rpcConfig',
						json('true')
					),
				secrets_ref,
				COALESCE(settings_json, '{}'),
				created_at,
				updated_at
			FROM external_event_source_configs
		`);
  }

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_external_event_source_configs (
			space_id TEXT NOT NULL,
			source TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 0,
			settings_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(space_id, source),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);

  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO external_event_extension_configs
		 (source, globally_enabled, capabilities_json, secrets_ref, settings_json, created_at, updated_at)
		 VALUES ('github', 1, ?, NULL, '{}', ?, ?)`
  ).run(JSON.stringify({ webhooks: true, polling: false, rpcConfig: true }), now, now);
}

export function runMigration129(db: BunDatabase): void {
  if (!tableExists(db, 'spaces')) return;
  if (tableHasColumn(db, 'spaces', 'max_concurrent_tasks')) return;

  db.exec(`ALTER TABLE spaces ADD COLUMN max_concurrent_tasks INTEGER NOT NULL DEFAULT 1`);
  db.exec(`
		UPDATE spaces
		SET max_concurrent_tasks = CAST(json_extract(config, '$.maxConcurrentTasks') AS INTEGER)
		WHERE config IS NOT NULL
		  AND json_valid(config)
		  AND json_type(config, '$.maxConcurrentTasks') = 'integer'
		  AND CAST(json_extract(config, '$.maxConcurrentTasks') AS INTEGER) BETWEEN 1 AND 10
	`);
}

export function runMigration130(db: BunDatabase): void {
  if (tableExists(db, 'gate_open_state')) return;

  db.exec(`
		CREATE TABLE gate_open_state (
			run_id TEXT NOT NULL,
			gate_id TEXT NOT NULL,
			opened_workflow_updated_at INTEGER NOT NULL,
			opened_at INTEGER NOT NULL,
			PRIMARY KEY (run_id, gate_id),
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);
  db.exec(`CREATE INDEX idx_gate_open_state_run ON gate_open_state(run_id)`);
}

export function runMigration131(db: BunDatabase): void {
  if (tableExists(db, 'neo_activity_log')) {
    db.exec(`DROP TABLE neo_activity_log`);
  }

  migrateNeoSessions(db);
  migrateNeoMessageOrigins(db);

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_goals (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'paused', 'completed', 'archived')),
			type TEXT NOT NULL DEFAULT 'one_shot'
				CHECK(type IN ('one_shot', 'measurable', 'recurring')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			labels TEXT NOT NULL DEFAULT '[]',
			metrics TEXT NOT NULL DEFAULT '{}',
			summary TEXT NOT NULL DEFAULT '',
			progress INTEGER NOT NULL DEFAULT 0,
			next_steps TEXT NOT NULL DEFAULT '[]',
			preferred_workflow_id TEXT,
			task_schedule_id TEXT,
			auto_trigger_next INTEGER NOT NULL DEFAULT 0,
			pending_next_run INTEGER NOT NULL DEFAULT 0,
			active_task_id TEXT,
			last_task_id TEXT,
			last_check_in_at INTEGER,
			next_check_in_at INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_goals_space ON space_goals(space_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_goals_schedule ON space_goals(task_schedule_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_goals_active_task ON space_goals(active_task_id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_goals_next_check_in ON space_goals(status, next_check_in_at)`
  );

  if (tableExists(db, 'space_tasks') && !tableHasColumn(db, 'space_tasks', 'goal_id')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN goal_id TEXT DEFAULT NULL`);
  }
  if (tableExists(db, 'space_tasks')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_id ON space_tasks(goal_id)`);
  }

  if (tableExists(db, 'task_schedules') && !tableHasColumn(db, 'task_schedules', 'goal_id')) {
    db.exec(`ALTER TABLE task_schedules ADD COLUMN goal_id TEXT DEFAULT NULL`);
  }
  if (tableExists(db, 'task_schedules') && !tableHasColumn(db, 'task_schedules', 'metadata_json')) {
    db.exec(`ALTER TABLE task_schedules ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'`);
  }
  if (tableExists(db, 'task_schedules')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_task_schedules_goal ON task_schedules(goal_id)`);
  }
}

export function runMigration136(db: BunDatabase): void {
  if (!tableExists(db, 'space_agent_memory')) return;
  ensureAgentMemoryNamedPrimaryKey(db);

  if (!tableHasColumn(db, 'space_agent_memory', 'embedding_status')) {
    db.exec(
      `ALTER TABLE space_agent_memory ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending' CHECK(embedding_status IN ('pending', 'ready', 'failed'))`
    );
  }
  if (!tableHasColumn(db, 'space_agent_memory', 'embedding_model')) {
    db.exec(`ALTER TABLE space_agent_memory ADD COLUMN embedding_model TEXT`);
  }
  if (!tableHasColumn(db, 'space_agent_memory', 'embedding_updated_at')) {
    db.exec(`ALTER TABLE space_agent_memory ADD COLUMN embedding_updated_at INTEGER`);
  }
  if (!tableHasColumn(db, 'space_agent_memory', 'embedding_error')) {
    db.exec(`ALTER TABLE space_agent_memory ADD COLUMN embedding_error TEXT`);
  }
  if (!tableHasColumn(db, 'space_agent_memory', 'embedding_revision')) {
    db.exec(
      `ALTER TABLE space_agent_memory ADD COLUMN embedding_revision INTEGER NOT NULL DEFAULT 0`
    );
  }
  if (!tableHasColumn(db, 'space_agent_memory', 'embedding_token')) {
    db.exec(`ALTER TABLE space_agent_memory ADD COLUMN embedding_token TEXT NOT NULL DEFAULT ''`);
  }

  recreateMemoryVectorsWithNamedParentKey(db);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_memory_embedding_status ON space_agent_memory(space_id, embedding_status)`
  );
}

function ensureAgentMemoryNamedPrimaryKey(db: BunDatabase): void {
  if (tableHasColumn(db, 'space_agent_memory', 'id')) return;

  db.exec(`DROP TRIGGER IF EXISTS space_agent_memory_ai`);
  db.exec(`DROP TRIGGER IF EXISTS space_agent_memory_ad`);
  db.exec(`DROP TRIGGER IF EXISTS space_agent_memory_au`);
  db.exec(`DROP TABLE IF EXISTS space_agent_memory_fts`);

  db.exec(`ALTER TABLE space_agent_memory RENAME TO space_agent_memory_old`);
  db.exec(`
		CREATE TABLE space_agent_memory (
			id INTEGER PRIMARY KEY,
			key TEXT NOT NULL,
			space_id TEXT NOT NULL,
			content TEXT NOT NULL,
			tags TEXT NOT NULL DEFAULT '',
			created_by_session TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			access_count INTEGER NOT NULL DEFAULT 0,
			last_accessed_at INTEGER,
			UNIQUE(space_id, key),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		INSERT INTO space_agent_memory (
			id, key, space_id, content, tags, created_by_session, created_at, updated_at, access_count, last_accessed_at
		)
		SELECT rowid, key, space_id, content, tags, created_by_session, created_at, updated_at, access_count, last_accessed_at
		FROM space_agent_memory_old
	`);
  db.exec(`DROP TABLE space_agent_memory_old`);
  createAgentMemoryTables(db);
}

function recreateMemoryVectorsWithNamedParentKey(db: BunDatabase): void {
  if (tableExists(db, 'memory_vectors') && tableHasColumn(db, 'memory_vectors', 'memory_id')) {
    return;
  }

  db.exec(`DROP TABLE IF EXISTS memory_vectors`);
  db.exec(`
		CREATE TABLE memory_vectors (
			memory_id INTEGER PRIMARY KEY,
			embedding BLOB NOT NULL,
			dimensions INTEGER NOT NULL,
			model TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (memory_id) REFERENCES space_agent_memory(id) ON DELETE CASCADE
		)
	`);
}

export function runMigration134(db: BunDatabase): void {
  const existed = tableExists(db, 'message_search_fts');
  createMessageSearchContentTable(db);
  createMessageSearchFtsTable(db);
  createMessageSearchSyncTriggers(db);
  if (!existed || isMessageSearchFtsEmpty(db)) {
    backfillMessageSearchFts(db);
  }
  configureMessageSearchFts(db, { automerge: 16 });
}

export function runMigration137(db: BunDatabase): void {
  if (!tableExists(db, 'message_search_content')) return;
  const prunedRows = pruneMessageSearchFts(db);

  if (prunedRows > 0 && tableExists(db, 'message_search_fts')) {
    db.exec(`INSERT INTO message_search_fts(message_search_fts) VALUES('optimize')`);
  }
}

function pruneMessageSearchFts(db: BunDatabase): number {
  let prunedRows = 0;
  const recordPrune = (result: { changes?: number }): void => {
    prunedRows += result.changes ?? 0;
  };
  const terminalCutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const terminalCutoffIso = new Date(terminalCutoffMs).toISOString();

  recordPrune(
    db
      .prepare(
        `DELETE FROM message_search_content
				 WHERE kind = 'message'
				   AND COALESCE(message_type, '') NOT IN ('system', 'user', 'assistant')`
      )
      .run()
  );

  const deleteRoomNamespacedRows = db.prepare(`
		DELETE FROM message_search_content
		WHERE kind = 'message'
		  AND (
			session_id LIKE 'room:chat:%'
			OR session_id LIKE 'planner:%'
			OR session_id LIKE 'coder:%'
			OR session_id LIKE 'leader:%'
			OR session_id LIKE 'general:%'
			OR (instr(session_id, ':') > 0 AND session_id NOT LIKE 'space:%')
		  )
	`);
  recordPrune(deleteRoomNamespacedRows.run());

  if (
    tableExists(db, 'sessions') &&
    tableHasColumn(db, 'sessions', 'status') &&
    tableHasColumn(db, 'sessions', 'type') &&
    tableHasColumn(db, 'sessions', 'last_active_at') &&
    tableHasColumn(db, 'sessions', 'session_context')
  ) {
    recordPrune(
      db
        .prepare(
          `
					DELETE FROM message_search_content
					WHERE kind = 'message'
					  AND session_id IN (
						SELECT id
						FROM sessions
						WHERE status = 'archived'
						   OR (status = 'ended' AND last_active_at < ?)
						   OR type IN ('room_chat', 'planner', 'coder', 'leader', 'general')
						   OR (json_valid(session_context) AND json_extract(session_context, '$.roomId') IS NOT NULL)
						   OR (id NOT LIKE 'space:%' AND instr(id, ':') > 0)
						   OR (id NOT LIKE 'space:%' AND type NOT IN ('worker', 'space_chat', 'space_task_agent'))
					  )
				`
        )
        .run(terminalCutoffIso)
    );
  }

  if (
    tableExists(db, 'space_tasks') &&
    tableHasColumn(db, 'space_tasks', 'status') &&
    tableHasColumn(db, 'space_tasks', 'completed_at') &&
    tableHasColumn(db, 'space_tasks', 'updated_at')
  ) {
    recordPrune(
      db
        .prepare(
          `
					DELETE FROM message_search_content
					WHERE kind = 'message'
					  AND task_id IN (
						SELECT id
						FROM space_tasks
						WHERE status = 'archived'
						   OR (status IN ('done', 'cancelled', 'completed')
						       AND COALESCE(completed_at, updated_at, 0) < ?)
					  )
				`
        )
        .run(terminalCutoffMs)
    );
  }

  return prunedRows;
}

function isMessageSearchFtsEmpty(db: BunDatabase): boolean {
  const row = db.prepare(`SELECT 1 AS present FROM message_search_fts LIMIT 1`).get() as
    | { present: number }
    | undefined;
  return !row;
}

function createMessageSearchContentTable(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS message_search_content (
			id INTEGER PRIMARY KEY,
			kind TEXT NOT NULL CHECK(kind IN ('message', 'task')),
			source_id TEXT NOT NULL,
			message_id TEXT,
			session_id TEXT,
			task_id TEXT,
			space_id TEXT,
			task_number INTEGER,
			message_type TEXT,
			title TEXT,
			body TEXT,
			timestamp INTEGER,
			UNIQUE (kind, source_id)
		)
	`);
}

function createMessageSearchFtsTable(db: BunDatabase): void {
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS message_search_fts USING fts5(
			title,
			body,
			content='message_search_content',
			content_rowid='id',
			detail=column,
			tokenize = 'unicode61'
		)
	`);
}

function createMessageSearchSyncTriggers(db: BunDatabase): void {
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS message_search_content_ai
		AFTER INSERT ON message_search_content BEGIN
			INSERT INTO message_search_fts(rowid, title, body)
			VALUES (new.id, new.title, new.body);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS message_search_content_ad
		AFTER DELETE ON message_search_content BEGIN
			INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
			VALUES ('delete', old.id, old.title, old.body);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS message_search_content_au
		AFTER UPDATE OF title, body ON message_search_content BEGIN
			INSERT INTO message_search_fts(message_search_fts, rowid, title, body)
			VALUES ('delete', old.id, old.title, old.body);
			INSERT INTO message_search_fts(rowid, title, body)
			VALUES (new.id, new.title, new.body);
		END
	`);
}

export function configureMessageSearchFts(
  db: BunDatabase,
  options: { automerge?: 0 | 16 } = {}
): void {
  if (!tableExists(db, 'message_search_fts')) return;
  db.exec(
    `INSERT INTO message_search_fts(message_search_fts, rank) VALUES('automerge', ${options.automerge ?? 0})`
  );
  db.exec(`INSERT INTO message_search_fts(message_search_fts, rank) VALUES('crisismerge', 64)`);
}

function backfillMessageSearchFts(db: BunDatabase): void {
  db.exec(`DELETE FROM message_search_content`);

  if (tableExists(db, 'sdk_messages')) {
    const sessionTitleSelect = tableExists(db, 'sessions')
      ? 'COALESCE(s.title, sm.session_id)'
      : 'sm.session_id';
    const sessionJoin = tableExists(db, 'sessions')
      ? 'LEFT JOIN sessions s ON s.id = sm.session_id'
      : '';
    const taskSelect = tableExists(db, 'space_tasks')
      ? 'st.space_id, st.task_number'
      : 'NULL, NULL';
    const taskJoin = tableExists(db, 'space_tasks')
      ? 'LEFT JOIN space_tasks st ON st.id = sm.task_id'
      : '';
    db.exec(`
			INSERT INTO message_search_content (
				kind, source_id, message_id, session_id, task_id, space_id, task_number,
				message_type, title, body, timestamp
			)
			SELECT
				'message',
				sm.id,
				json_extract(sm.sdk_message, '$.uuid'),
				sm.session_id,
				sm.task_id,
				${taskSelect},
				sm.message_type,
				${sessionTitleSelect},
				TRIM(COALESCE(
					CASE
						WHEN json_valid(sm.sdk_message)
						 AND json_type(sm.sdk_message, '$.message.content') = 'text'
						THEN json_extract(sm.sdk_message, '$.message.content')
					END,
					''
				) || ' ' || COALESCE(
					CASE
						WHEN json_valid(sm.sdk_message)
						 AND json_type(sm.sdk_message, '$.message.content') = 'array'
						THEN (
							SELECT group_concat(
								CASE
									WHEN json_extract(je.value, '$.type') = 'text'
									THEN json_extract(je.value, '$.text')
									WHEN json_extract(je.value, '$.type') = 'thinking'
									THEN json_extract(je.value, '$.thinking')
								END,
								' '
							)
							FROM json_each(json_extract(sm.sdk_message, '$.message.content')) je
							WHERE json_extract(je.value, '$.type') IN ('text', 'thinking')
						)
					END,
					''
				) || ' ' || COALESCE(
					CASE
						WHEN json_valid(sm.sdk_message)
						 AND sm.message_type = 'result'
						THEN json_extract(sm.sdk_message, '$.result')
					END,
					''
				) || ' ' || COALESCE(
					CASE
						WHEN json_valid(sm.sdk_message)
						 AND sm.message_type = 'hyperneo_action'
						THEN TRIM(COALESCE(json_extract(sm.sdk_message, '$.title'), '') || ' '
							|| COALESCE(json_extract(sm.sdk_message, '$.message'), '') || ' '
							|| COALESCE(json_extract(sm.sdk_message, '$.question'), '') || ' '
							|| COALESCE(json_extract(sm.sdk_message, '$.prompt'), '') || ' '
							|| COALESCE(json_extract(sm.sdk_message, '$.action'), ''))
					END,
					''
				)),
				CAST(strftime('%s', sm.timestamp) AS INTEGER) * 1000
						+ CAST(substr(strftime('%f', sm.timestamp), 4, 3) AS INTEGER)
			FROM sdk_messages sm
			${sessionJoin}
			${taskJoin}
			WHERE json_valid(sm.sdk_message)
			  AND sm.message_type IN ('system', 'user', 'assistant')
			  AND (sm.message_type != 'user' OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
		`);
  }

  if (tableExists(db, 'space_tasks')) {
    db.exec(`
			INSERT INTO message_search_content (
				kind, source_id, task_id, space_id, task_number, title, body, timestamp
			)
			SELECT
				'task',
				id,
				id,
				space_id,
				task_number,
				title,
				TRIM(COALESCE(title, '') || ' ' || COALESCE(description, '')),
				updated_at
			FROM space_tasks
			WHERE TRIM(COALESCE(title, '') || ' ' || COALESCE(description, '')) != ''
		`);
  }
}

function migrateNeoSessions(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) return;

  const createSql = tableCreateSql(db, 'sessions');
  if (createSql && !createSql.includes("'neo'")) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
			CREATE TABLE sessions_m131_new (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				workspace_path TEXT,
				created_at TEXT NOT NULL,
				last_active_at TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
				config TEXT NOT NULL,
				metadata TEXT NOT NULL,
				is_worktree INTEGER DEFAULT 0,
				worktree_path TEXT,
				main_repo_path TEXT,
				worktree_branch TEXT,
				git_branch TEXT,
				sdk_session_id TEXT,
				sdk_origin_path TEXT,
				available_commands TEXT,
				processing_state TEXT,
				archived_at TEXT,
				parent_id TEXT,
				type TEXT DEFAULT 'worker' CHECK(type IN ('worker', 'room_chat', 'planner', 'coder', 'leader', 'general', 'lobby', 'spaces_global', 'space_task_agent', 'space_chat')),
				session_context TEXT
			)
		`);
    db.exec(`
			INSERT INTO sessions_m131_new (
				id, title, workspace_path, created_at, last_active_at, status, config, metadata,
				is_worktree, worktree_path, main_repo_path, worktree_branch, git_branch,
				sdk_session_id, sdk_origin_path, available_commands, processing_state,
				archived_at, parent_id, type, session_context
			)
			SELECT
				id, title, workspace_path, created_at, last_active_at,
				CASE WHEN type = 'neo' THEN 'archived' ELSE status END,
				config, metadata, is_worktree, worktree_path, main_repo_path, worktree_branch,
				git_branch, sdk_session_id, sdk_origin_path, available_commands, processing_state,
				CASE WHEN type = 'neo' AND archived_at IS NULL THEN datetime('now') ELSE archived_at END,
				parent_id,
				CASE WHEN type = 'neo' THEN 'worker' ELSE type END,
				session_context
			FROM sessions
		`);
    db.exec(`DROP TABLE sessions`);
    db.exec(`ALTER TABLE sessions_m131_new RENAME TO sessions`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function runMigration142(db: BunDatabase): void {
  widenEvolutionEvidenceKinds(db);
  backfillForgeMvpEvidence(db);
}

export function runMigration143(db: BunDatabase): void {
  widenEvolutionEvidenceKinds(db);
}

function createSpaceAgentManagementTables(db: BunDatabase): void {
  if (tableExists(db, 'space_agents') && !tableHasColumn(db, 'space_agents', 'status')) {
    db.exec(
      `ALTER TABLE space_agents ADD COLUMN status TEXT NOT NULL DEFAULT 'active' ` +
        `CHECK(status IN ('active', 'paused', 'archived'))`
    );
  }

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_agent_goal_assignments (
			space_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			goal_id TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (agent_id, goal_id),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (agent_id) REFERENCES space_agents(id) ON DELETE CASCADE,
			FOREIGN KEY (goal_id) REFERENCES space_goals(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_goal_assignments_goal ` +
      `ON space_agent_goal_assignments(space_id, goal_id)`
  );

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_agent_forge_scope_assignments (
			space_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (agent_id, scope_id),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (agent_id) REFERENCES space_agents(id) ON DELETE CASCADE,
			FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_forge_scope_assignments_scope ` +
      `ON space_agent_forge_scope_assignments(space_id, scope_id)`
  );

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_agent_reminders (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			message TEXT NOT NULL,
			remind_at INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'done', 'cancelled')),
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (agent_id) REFERENCES space_agents(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_reminders_agent_status ` +
      `ON space_agent_reminders(space_id, agent_id, status, remind_at)`
  );

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_agent_event_subscriptions (
			space_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			topic_pattern TEXT NOT NULL,
			label TEXT,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (agent_id, topic_pattern),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (agent_id) REFERENCES space_agents(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_event_subscriptions_space ` +
      `ON space_agent_event_subscriptions(space_id, topic_pattern)`
  );
}

export function runMigration145(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;
  if (!tableHasColumn(db, 'space_tasks', 'workflow_model_overrides')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN workflow_model_overrides TEXT`);
  }
}

export function runMigration146(db: BunDatabase): void {
  widenEvolutionEvidenceKinds(db);
}

function widenEvolutionEvidenceKinds(db: BunDatabase): void {
  if (!tableExists(db, 'evolution_evidence')) return;
  const sql = tableCreateSql(db, 'evolution_evidence');
  if (
    sql?.includes("'task_result'") &&
    sql.includes("'artifact'") &&
    sql.includes("'error'") &&
    sql.includes("'daemon_error'") &&
    sql.includes("'runtime_crash'") &&
    sql.includes("'runtime_warning'") &&
    sql.includes("'uncaught_exception'") &&
    sql.includes("'error_cluster'") &&
    sql.includes("'retry_loop'") &&
    sql.includes("'tool_failure'") &&
    sql.includes("'test_failure'") &&
    sql.includes("'permission_block'") &&
    sql.includes("'slow_tool_call'") &&
    sql.includes("'conversation_friction'") &&
    sql.includes("'friction_digest'") &&
    sql.includes("'verification_triage'")
  ) {
    return;
  }

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`DROP TABLE IF EXISTS evolution_evidence_new`);
    db.exec(`
			CREATE TABLE evolution_evidence_new (
				id TEXT PRIMARY KEY,
				scope_id TEXT NOT NULL,
				kind TEXT NOT NULL
					CHECK(kind IN ('task', 'workflow_run', 'session', 'manual_note', 'metric_snapshot', 'task_result', 'artifact', 'error', 'daemon_error', 'runtime_crash', 'runtime_warning', 'uncaught_exception', 'error_cluster', 'retry_loop', 'tool_failure', 'test_failure', 'permission_block', 'slow_tool_call', 'conversation_friction', 'friction_digest', 'verification_triage')),
				summary TEXT NOT NULL,
				source_id TEXT,
				metadata_json TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
			)
		`);
    db.exec(`
			INSERT INTO evolution_evidence_new (
				id, scope_id, kind, summary, source_id, metadata_json, created_at
			)
			SELECT id, scope_id, kind, summary, source_id, metadata_json, created_at
			FROM evolution_evidence
		`);
    db.exec(`DROP TABLE evolution_evidence`);
    db.exec(`ALTER TABLE evolution_evidence_new RENAME TO evolution_evidence`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_evolution_evidence_scope_created ON evolution_evidence(scope_id, created_at DESC)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_evolution_evidence_source ON evolution_evidence(kind, source_id)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_evolution_evidence_scope_source_created ON evolution_evidence(scope_id, source_id, created_at DESC, id DESC)`
    );
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function backfillForgeMvpEvidence(db: BunDatabase): void {
  if (!tableExists(db, 'evolution_scopes') || !tableExists(db, 'evolution_evidence')) return;
  if (!tableExists(db, 'space_tasks') || !tableExists(db, 'space_workflow_runs')) return;
  if (!tableExists(db, 'workflow_run_artifacts')) return;

  const hasTaskSpaceId = tableHasColumn(db, 'space_tasks', 'space_id');
  const scope = db
    .prepare(
      `SELECT id, space_id FROM evolution_scopes
			 WHERE id = ?
			    OR (space_goal_id = ? AND name = ?)
			 ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
			 LIMIT 1`
    )
    .get(
      'b2ff245a-98ef-4429-954a-3e7b96366cfa',
      '10612c8d-e412-4169-8429-b48fa4d3e234',
      'Build and harden NeoKai Forge',
      'b2ff245a-98ef-4429-954a-3e7b96366cfa'
    ) as { id: string; space_id: string } | undefined;
  if (!scope) return;

  const taskWhere = hasTaskSpaceId ? 'space_id = ? AND task_number = ?' : 'task_number = ?';
  const tasks = [425, 426, 427, 428, 429, 430, 431];
  for (const taskNumber of tasks) {
    const task = db
      .prepare(
        `SELECT id, task_number, title, description, status, priority, workflow_run_id,
				        reported_status, reported_summary, result, completed_at, updated_at
				 FROM space_tasks WHERE ${taskWhere}`
      )
      .get(...(hasTaskSpaceId ? [scope.space_id, taskNumber] : [taskNumber])) as
      | ForgeMvpTaskRow
      | undefined;
    if (!task?.workflow_run_id) continue;
    const run = db
      .prepare(
        `SELECT id, title, status, failure_reason, completed_at, updated_at
				 FROM space_workflow_runs WHERE id = ?`
      )
      .get(task.workflow_run_id) as ForgeMvpRunRow | undefined;
    const artifacts = db
      .prepare(
        `SELECT id, node_id, artifact_type, artifact_key, data, created_at, updated_at
				 FROM workflow_run_artifacts WHERE run_id = ? ORDER BY created_at, id`
      )
      .all(task.workflow_run_id) as ForgeMvpArtifactRow[];
    const parsedArtifacts = artifacts.map((artifact) => ({
      id: artifact.id,
      nodeId: artifact.node_id,
      type: artifact.artifact_type,
      key: artifact.artifact_key,
      data: parseMigrationJson(artifact.data),
      createdAt: artifact.created_at,
      updatedAt: artifact.updated_at,
    }));
    const artifactSummaries = parsedArtifacts
      .map((artifact) => extractArtifactSummary(artifact.data))
      .filter((summary): summary is string => Boolean(summary));
    const prUrls = uniqueStrings(
      parsedArtifacts.flatMap((artifact) => extractArtifactUrls(artifact.data))
    );
    const errors = collectForgeMvpErrors(run, parsedArtifacts);
    const createdAt = task.completed_at ?? task.updated_at;

    upsertForgeEvidence(db, {
      id: `forge-mvp-${taskNumber}-task-result`,
      scopeId: scope.id,
      kind: 'task_result',
      summary: `Task #${taskNumber} completed: ${task.title}. Workflow run ${run?.status ?? task.status}; PRs: ${prUrls.join(', ') || 'none recorded'}.`,
      sourceId: task.id,
      metadata: {
        task: {
          id: task.id,
          number: task.task_number,
          title: task.title,
          status: task.status,
          priority: task.priority,
          reportedStatus: task.reported_status,
          reportedSummary: task.reported_summary,
          result: task.result,
          completedAt: task.completed_at,
        },
        workflowRun: run,
        prUrls,
        artifactCount: artifacts.length,
      },
      createdAt,
    });

    upsertForgeEvidence(db, {
      id: `forge-mvp-${taskNumber}-artifact`,
      scopeId: scope.id,
      kind: 'artifact',
      summary: `Task #${taskNumber} artifacts: ${artifactSummaries.join(' | ') || `${artifacts.length} workflow artifacts captured`}.`,
      sourceId: task.workflow_run_id,
      metadata: { taskNumber, workflowRunId: task.workflow_run_id, artifacts: parsedArtifacts },
      createdAt,
    });

    if (errors.length > 0) {
      upsertForgeEvidence(db, {
        id: `forge-mvp-${taskNumber}-error`,
        scopeId: scope.id,
        kind: 'error',
        summary: `Task #${taskNumber} error/rework signals: ${errors.map((error) => error.summary).join(' | ')}.`,
        sourceId: task.workflow_run_id,
        metadata: { taskNumber, workflowRunId: task.workflow_run_id, errors },
        createdAt,
      });
    }
  }
}

interface ForgeMvpTaskRow {
  id: string;
  task_number: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  workflow_run_id: string | null;
  reported_status: string | null;
  reported_summary: string | null;
  result: string | null;
  completed_at: number | null;
  updated_at: number;
}

interface ForgeMvpRunRow {
  id: string;
  title: string;
  status: string;
  failure_reason: string | null;
  completed_at: number | null;
  updated_at: number;
}

interface ForgeMvpArtifactRow {
  id: string;
  node_id: string;
  artifact_type: string;
  artifact_key: string;
  data: string;
  created_at: number;
  updated_at: number;
}

interface ForgeEvidenceUpsert {
  id: string;
  scopeId: string;
  kind: 'task_result' | 'artifact' | 'error';
  summary: string;
  sourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

function upsertForgeEvidence(db: BunDatabase, evidence: ForgeEvidenceUpsert): void {
  db.prepare(
    `INSERT INTO evolution_evidence (
			id, scope_id, kind, summary, source_id, metadata_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			scope_id = excluded.scope_id,
			kind = excluded.kind,
			summary = excluded.summary,
			source_id = excluded.source_id,
			metadata_json = excluded.metadata_json,
			created_at = excluded.created_at`
  ).run(
    evidence.id,
    evidence.scopeId,
    evidence.kind,
    evidence.summary,
    evidence.sourceId,
    JSON.stringify(evidence.metadata),
    evidence.createdAt
  );
}

function collectForgeMvpErrors(
  run: ForgeMvpRunRow | undefined,
  artifacts: Array<{ data: Record<string, unknown> }>
): Array<{ summary: string; data: Record<string, unknown> }> {
  const errors: Array<{ summary: string; data: Record<string, unknown> }> = [];
  if (run?.failure_reason) {
    errors.push({ summary: run.failure_reason, data: { source: 'workflow_run', runId: run.id } });
  }
  for (const artifact of artifacts) {
    const summary = extractArtifactSummary(artifact.data);
    const verdict = stringValue(artifact.data.verdict);
    const gateBlocker = stringValue(artifact.data.gateBlocker ?? artifact.data.gate_reason);
    const gateIssue = stringValue(artifact.data.gateIssue);
    const blockingIssues = Array.isArray(artifact.data.blocking_issues)
      ? artifact.data.blocking_issues
      : [];
    const testOutput = stringValue(artifact.data.test_output);
    const hasRequestChanges = verdict === 'REQUEST_CHANGES';
    const hasGateBlocker = Boolean(gateBlocker || gateIssue);
    const hasBlockingIssues = blockingIssues.length > 0;
    const hasPreexistingFailure = /pre-existing/i.test(`${summary ?? ''} ${testOutput ?? ''}`);
    if (!hasRequestChanges && !hasGateBlocker && !hasBlockingIssues && !hasPreexistingFailure)
      continue;
    errors.push({
      summary: summary ?? gateBlocker ?? gateIssue ?? 'Error signal captured in workflow artifact',
      data: artifact.data,
    });
  }
  return errors;
}

function parseMigrationJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function extractArtifactSummary(data: Record<string, unknown>): string | null {
  return stringValue(data.summary) ?? stringValue(data.test_output) ?? null;
}

function extractArtifactUrls(data: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const key of ['pr_url', 'merged_pr_url', 'review_url', 'reviewUrl', 'url']) {
    const value = stringValue(data[key]);
    if (value) urls.push(value);
  }
  return urls;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function runMigration141(db: BunDatabase): void {
  const ftsSql = tableCreateSql(db, 'message_search_fts');
  const hasOptimizedFts =
    ftsSql?.includes("content='message_search_content'") && ftsSql.includes('detail=column');
  createMessageSearchContentTable(db);
  ensureStableMessageSearchIds(db);
  if (!hasOptimizedFts) {
    dropMessageSearchTriggers(db);
    db.exec(`DROP TABLE IF EXISTS message_search_fts`);
    backfillMessageSearchFts(db);
    pruneMessageSearchFts(db);
    createMessageSearchFtsTable(db);
    createMessageSearchSyncTriggers(db);
    db.exec(`INSERT INTO message_search_fts(message_search_fts) VALUES('rebuild')`);
  }
  configureMessageSearchFts(db);
}

function dropMessageSearchTriggers(db: BunDatabase): void {
  db.exec(`DROP TRIGGER IF EXISTS message_search_content_ai`);
  db.exec(`DROP TRIGGER IF EXISTS message_search_content_ad`);
  db.exec(`DROP TRIGGER IF EXISTS message_search_content_au`);
}

export function runMigration211(db: BunDatabase): void {
  const createReclaims = `
    CREATE TABLE IF NOT EXISTS migration_space_reclaims (
      migration_key TEXT PRIMARY KEY,
      reclaimed_at INTEGER NOT NULL
    )
  `;
  if (tableExists(db, 'message_search_content')) {
    ensureStableMessageSearchIds(db);
  }
  db.exec(createReclaims);
}

const MIGRATION_212_COPY_CHUNK_ROWS = 200_000;

export function runMigration212(
  db: BunDatabase,
  copyChunkRows: number = MIGRATION_212_COPY_CHUNK_ROWS
): void {
  if (!tableExists(db, 'sdk_messages')) return;
  const storedSql = tableCreateSql(db, 'sdk_messages');
  if (!!storedSql && /\bseq\s+INTEGER\s+PRIMARY KEY\b/i.test(storedSql)) return;

  const columns = (
    db.prepare(`PRAGMA table_xinfo('sdk_messages')`).all() as Array<{
      name: string;
      hidden: number;
    }>
  ).filter((column) => column.hidden === 0 && column.name !== 'seq');
  const columnNames = columns.map((column) => column.name);
  const indexRows = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sdk_messages' AND sql IS NOT NULL`
    )
    .all() as Array<{ sql: string }>;
  const triggerRows = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'sdk_messages' AND sql IS NOT NULL`
    )
    .all() as Array<{ sql: string }>;

  const newSql = (storedSql ?? '')
    .replace(
      /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?"?sdk_messages"?/i,
      'CREATE TABLE sdk_messages_m212_new'
    )
    .replace(/\bid\s+TEXT\s+PRIMARY\s+KEY\b/i, 'seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE');

  let resumeFrom: number | null = null;
  if (tableExists(db, 'sdk_messages_m212_new')) {
    const partialColumns = (
      db.prepare(`PRAGMA table_xinfo('sdk_messages_m212_new')`).all() as Array<{
        name: string;
        hidden: number;
      }>
    )
      .filter((column) => column.hidden === 0)
      .map((column) => column.name);
    if (
      partialColumns.length === columnNames.length + 1 &&
      partialColumns[0] === 'seq' &&
      partialColumns.slice(1).join(' ') === columnNames.join(' ')
    ) {
      resumeFrom =
        (
          db.prepare(`SELECT MAX(seq) AS maxSeq FROM sdk_messages_m212_new`).get() as
            | { maxSeq: number | null }
            | undefined
        )?.maxSeq ?? 0;
    } else {
      db.exec(`DROP TABLE sdk_messages_m212_new`);
    }
  }
  if (resumeFrom === null) {
    db.exec(newSql);
    resumeFrom = 0;
  }

  const foreignKeys = (
    db.prepare(`PRAGMA foreign_keys`).get() as { foreign_keys: number } | undefined
  )?.foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    const insertChunk = db.prepare(`
      INSERT INTO sdk_messages_m212_new (seq, ${columnNames.join(', ')})
      SELECT rowid, ${columnNames.join(', ')}
      FROM sdk_messages
      WHERE rowid > ? AND rowid <= ?
    `);
    const maxRowid =
      (
        db.prepare(`SELECT MAX(rowid) AS maxRowid FROM sdk_messages`).get() as
          | { maxRowid: number | null }
          | undefined
      )?.maxRowid ?? 0;
    let lastCopied = resumeFrom;
    while (lastCopied < maxRowid) {
      insertChunk.run(lastCopied, lastCopied + copyChunkRows);
      lastCopied += copyChunkRows;
    }
    db.exec('BEGIN');
    try {
      db.exec(`DROP TABLE sdk_messages`);
      db.exec(`ALTER TABLE sdk_messages_m212_new RENAME TO sdk_messages`);
      for (const index of indexRows) {
        db.exec(index.sql);
      }
      for (const trigger of triggerRows) {
        db.exec(trigger.sql);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys === 0 ? 'OFF' : 'ON'}`);
  }
}

function ensureStableMessageSearchIds(db: BunDatabase): void {
  const contentSql = tableCreateSql(db, 'message_search_content');
  const hasStableContentId = !!contentSql && /\bid\s+INTEGER\s+PRIMARY KEY\b/i.test(contentSql);
  const ftsSql = tableCreateSql(db, 'message_search_fts');
  const hasStableFtsId = ftsSql?.includes("content_rowid='id'");
  if (hasStableContentId && (hasStableFtsId || !ftsSql)) return;

  const foreignKeys = (
    db.prepare(`PRAGMA foreign_keys`).get() as { foreign_keys: number } | undefined
  )?.foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    dropMessageSearchTriggers(db);
    db.exec(`DROP TABLE IF EXISTS message_search_fts`);
    if (!hasStableContentId) {
      db.exec(`ALTER TABLE message_search_content RENAME TO message_search_content_stable_old`);
      createMessageSearchContentTable(db);
      db.exec(`
        INSERT INTO message_search_content (
          kind, source_id, message_id, session_id, task_id, space_id, task_number,
          message_type, title, body, timestamp
        )
        SELECT
          kind, source_id, message_id, session_id, task_id, space_id, task_number,
          message_type, title, body, timestamp
        FROM message_search_content_stable_old
      `);
      db.exec(`DROP TABLE message_search_content_stable_old`);
    }
    createMessageSearchFtsTable(db);
    createMessageSearchSyncTriggers(db);
    db.exec(`INSERT INTO message_search_fts(message_search_fts) VALUES('rebuild')`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys === 0 ? 'OFF' : 'ON'}`);
  }
}

export function runMigration133(db: BunDatabase): void {
  if (!tableExists(db, 'space_goals')) return;

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_goal_events (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			goal_id TEXT NOT NULL,
			event_type TEXT NOT NULL
				CHECK(event_type IN ('created', 'updated', 'status_changed', 'task_triggered', 'task_queued', 'task_terminal', 'schedule_updated')),
			source TEXT NOT NULL
				CHECK(source IN ('rpc', 'space_agent_tool', 'workflow_node_agent', 'scheduler', 'system')),
			source_task_id TEXT,
			source_session_id TEXT,
			previous_state TEXT,
			new_state TEXT,
			diff TEXT,
			note TEXT,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (goal_id) REFERENCES space_goals(id) ON DELETE CASCADE,
			FOREIGN KEY (source_task_id) REFERENCES space_tasks(id) ON DELETE SET NULL
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_goal_events_goal_created ON space_goal_events(goal_id, created_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_goal_events_space_created ON space_goal_events(space_id, created_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_goal_events_source_task ON space_goal_events(source_task_id, created_at DESC)`
  );
}

export function runMigration132(db: BunDatabase): void {
  createAgentMemoryTables(db);
}

function createAgentMemoryTables(db: BunDatabase): void {
  const shouldRebuildFts = !tableExists(db, 'space_agent_memory_fts');

  db.exec(`
		CREATE TABLE IF NOT EXISTS space_agent_memory (
			id INTEGER PRIMARY KEY,
			key TEXT NOT NULL,
			space_id TEXT NOT NULL,
			content TEXT NOT NULL,
			tags TEXT NOT NULL DEFAULT '',
			created_by_session TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			access_count INTEGER NOT NULL DEFAULT 0,
			last_accessed_at INTEGER,
			UNIQUE(space_id, key),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);

  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS space_agent_memory_fts USING fts5(
			key,
			content,
			tags,
			content='space_agent_memory',
			content_rowid='id',
			tokenize='trigram'
		)
	`);

  db.exec(`
		CREATE TRIGGER IF NOT EXISTS space_agent_memory_ai
		AFTER INSERT ON space_agent_memory BEGIN
			INSERT INTO space_agent_memory_fts(rowid, key, content, tags)
			VALUES (new.id, new.key, new.content, new.tags);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS space_agent_memory_ad
		AFTER DELETE ON space_agent_memory BEGIN
			INSERT INTO space_agent_memory_fts(space_agent_memory_fts, rowid, key, content, tags)
			VALUES ('delete', old.id, old.key, old.content, old.tags);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS space_agent_memory_au
		AFTER UPDATE OF key, content, tags ON space_agent_memory BEGIN
			INSERT INTO space_agent_memory_fts(space_agent_memory_fts, rowid, key, content, tags)
			VALUES ('delete', old.id, old.key, old.content, old.tags);
			INSERT INTO space_agent_memory_fts(rowid, key, content, tags)
			VALUES (new.id, new.key, new.content, new.tags);
		END
	`);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_memory_space ON space_agent_memory(space_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_memory_updated ON space_agent_memory(space_id, updated_at DESC)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_memory_access ON space_agent_memory(space_id, last_accessed_at DESC)`
  );
  if (shouldRebuildFts) {
    db.exec(`INSERT INTO space_agent_memory_fts(space_agent_memory_fts) VALUES ('rebuild')`);
  }
}

export function runMigration135(db: BunDatabase): void {
  if (!tableExists(db, 'pending_agent_messages')) return;

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_pending_agent_messages_space_status ` +
      `ON pending_agent_messages(space_id, status, created_at)`
  );
}

export function runMigration139(db: BunDatabase): void {
  createEvolutionTables(db);
  if (tableExists(db, 'goal_automation_cursors')) {
    if (!tableHasColumn(db, 'goal_automation_cursors', 'last_evidence_id')) {
      db.exec(`ALTER TABLE goal_automation_cursors ADD COLUMN last_evidence_id TEXT`);
    }
    const createSql = tableCreateSql(db, 'goal_automation_cursors') ?? '';
    if (createSql.includes('UNIQUE(goal_id, trigger_kind, trigger_key)')) {
      db.exec(`ALTER TABLE goal_automation_cursors RENAME TO goal_automation_cursors_old`);
      createEvolutionTables(db);
      db.exec(`
				INSERT OR IGNORE INTO goal_automation_cursors (
					id, space_id, goal_id, scope_id, trigger_kind, trigger_key,
					last_evidence_created_at, last_evidence_id, last_task_completed_at,
					last_external_event_id, last_episode_id, last_fired_at, metadata_json,
					created_at, updated_at
				)
				SELECT
					id, space_id, goal_id, scope_id, trigger_kind, trigger_key,
					last_evidence_created_at, last_evidence_id, last_task_completed_at,
					last_external_event_id, last_episode_id, last_fired_at, metadata_json,
					created_at, updated_at
				FROM goal_automation_cursors_old
			`);
      db.exec(`DROP TABLE goal_automation_cursors_old`);
      createEvolutionTables(db);
    }
  }
  if (tableExists(db, 'space_tasks') && !tableHasColumn(db, 'space_tasks', 'evolution_scope_id')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN evolution_scope_id TEXT DEFAULT NULL`);
  }
  if (tableExists(db, 'space_tasks')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_space_tasks_evolution_scope_id ON space_tasks(evolution_scope_id)`
    );
  }
}

export function runMigration138(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_agent_inbox_messages (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			target_agent_id TEXT NOT NULL,
			source_actor_id TEXT NOT NULL,
			source_session_id TEXT,
			message TEXT NOT NULL,
			message_record_json TEXT,
			idempotency_key TEXT,
			attempts INTEGER NOT NULL DEFAULT 0,
			max_attempts INTEGER NOT NULL DEFAULT 5,
			last_attempt_at INTEGER,
			last_error TEXT,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'delivered', 'expired', 'failed')),
			delivered_at INTEGER,
			delivered_session_id TEXT,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (target_agent_id) REFERENCES space_agents(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_inbox_target_status ` +
      `ON space_agent_inbox_messages(space_id, target_agent_id, status, created_at)`
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_space_agent_inbox_idempotency ` +
      `ON space_agent_inbox_messages(space_id, target_agent_id, idempotency_key) ` +
      `WHERE idempotency_key IS NOT NULL AND status = 'pending'`
  );
  if (tableExists(db, 'sessions')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_space_agent_provenance ` +
        `ON sessions(json_extract(session_context, '$.spaceId'), json_extract(metadata, '$.promptProvenance.agentId'))`
    );
  }
}

export function runMigration140(db: BunDatabase): void {
  if (!tableExists(db, 'space_agent_memory')) return;
  db.exec(`
		CREATE TABLE IF NOT EXISTS space_agent_core_memory (
			space_id TEXT NOT NULL,
			memory_id INTEGER NOT NULL,
			score REAL NOT NULL,
			rank INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (space_id, memory_id),
			UNIQUE(space_id, rank),
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
			FOREIGN KEY (memory_id) REFERENCES space_agent_memory(id) ON DELETE CASCADE
		)
	`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_agent_core_memory_rank ON space_agent_core_memory(space_id, rank)`
  );
}

export function runMigration153(db: BunDatabase): void {
  if (tableExists(db, 'space_workflows') && !tableHasColumn(db, 'space_workflows', 'hooks')) {
    db.exec(`ALTER TABLE space_workflows ADD COLUMN hooks TEXT`);
  }

  if (!tableExists(db, 'space_workflow_runs')) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_hook_state (
      run_id TEXT NOT NULL,
      hook_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      local_state TEXT NOT NULL DEFAULT '{}',
      last_result TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      vote_maps TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, hook_id),
      FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_hook_state_run ON workflow_hook_state(run_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_hook_result_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      hook_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_workflow_hook_result_artifacts_run_hook ` +
      `ON workflow_hook_result_artifacts(run_id, hook_id, created_at)`
  );
}

export function runMigration144(db: BunDatabase): void {
  createLongHorizonAgentTables(db);
  createSpaceAgentManagementTables(db);
  backfillCoordinatorLongHorizonAgents(db);
}

function backfillCoordinatorLongHorizonAgents(db: BunDatabase): void {
  if (!tableExists(db, 'spaces')) return;
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO space_long_horizon_agents (
			id, space_id, handle, display_name, template_key, status, session_id,
			instructions, autonomy_level, tool_permissions_json, created_at, updated_at
		)
		SELECT
			'space-lh-agent:coordinator:' || id,
			id,
			'coordinator',
			'Coordinator',
			'coordinator.default',
			'active',
			'space:chat:' || id,
			'Coordinate goals, tasks, reminders, event subscriptions, and Space activity.',
			NULL,
			'{}',
			?,
			?
		FROM spaces`
  ).run(now, now);
}

function migrateNeoMessageOrigins(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) return;

  const createSql = tableCreateSql(db, 'sdk_messages');
  if (createSql && !createSql.includes("'neo'")) return;

  const columns = tableColumnNames(db, 'sdk_messages');
  const optionalColumns = ['is_renderable', 'is_terminal', 'parent_tool_use_id', 'task_id'].filter(
    (column) => columns.includes(column)
  );
  const insertColumns = [
    'id',
    'session_id',
    'message_type',
    'message_subtype',
    'sdk_message',
    'timestamp',
    'send_status',
    'origin',
    ...optionalColumns,
  ];

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
			CREATE TABLE sdk_messages_m131_new (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT DEFAULT 'consumed' CHECK(send_status IN ('deferred', 'enqueued', 'consumed', 'failed')),
				origin TEXT DEFAULT NULL CHECK(origin IS NULL OR origin IN ('human', 'system')),
				is_renderable INTEGER NOT NULL DEFAULT 1,
				is_terminal INTEGER NOT NULL DEFAULT 0,
				parent_tool_use_id TEXT,
				task_id TEXT,
				FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
			)
		`);
    db.exec(`
			INSERT INTO sdk_messages_m131_new (${insertColumns.join(', ')})
			SELECT ${insertColumns
        .map((column) =>
          column === 'origin' ? "CASE WHEN origin = 'neo' THEN NULL ELSE origin END" : column
        )
        .join(', ')}
			FROM sdk_messages
		`);
    db.exec(`DROP TABLE sdk_messages`);
    db.exec(`ALTER TABLE sdk_messages_m131_new RENAME TO sdk_messages`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_session ON sdk_messages(session_id, timestamp)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_timestamp_id ON sdk_messages(session_id, timestamp DESC, id DESC)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_parent_tool_use_id ON sdk_messages(session_id, parent_tool_use_id)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_renderable_terminal ON sdk_messages(session_id, is_renderable, is_terminal, timestamp, id)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_uuid_status ON sdk_messages(session_id, send_status, json_extract(sdk_message, '$.uuid'))`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_type ON sdk_messages(message_type, message_subtype)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status ON sdk_messages(session_id, send_status)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id ON sdk_messages(task_id, timestamp)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_session ON sdk_messages(task_id, session_id)`
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function generateValidHandle(name: string, existingHandles: string[]): string {
  const maxLen = 60;
  let base = slugify(name, existingHandles);
  if (validateSlug(base) === null) return base;

  for (let len = maxLen; len > 0; len--) {
    const truncated = base.slice(0, len);
    const cleaned = truncated.replace(/-+$/, '');
    const fallback = cleaned || 'agent';
    const candidate = slugify(fallback, existingHandles);
    if (validateSlug(candidate) === null) {
      return candidate;
    }
  }
  return 'agent';
}

function runMigration147(db: BunDatabase): void {
  if (!tableExists(db, 'space_long_horizon_agents')) return;
  for (const stmt of [
    `ALTER TABLE space_long_horizon_agents ADD COLUMN model TEXT DEFAULT NULL`,
    `ALTER TABLE space_long_horizon_agents ADD COLUMN thinking_level TEXT DEFAULT NULL`,
  ]) {
    try {
      db.exec(stmt);
    } catch {}
  }
}

export function runMigration148(db: BunDatabase): void {
  if (!tableExists(db, 'space_agents')) return;
  if (!tableHasColumn(db, 'space_agents', 'handle')) {
    db.exec(`ALTER TABLE space_agents ADD COLUMN handle TEXT`);
  }

  const rows = db
    .prepare(
      `SELECT id, space_id, name, handle FROM space_agents ORDER BY space_id, created_at, id`
    )
    .all() as Array<{ id: string; space_id: string; name: string; handle: string | null }>;

  const handlesBySpace = new Map<string, string[]>();
  for (const row of rows) {
    const existingHandles = handlesBySpace.get(row.space_id) ?? [...RESERVED_SPACE_AGENT_HANDLES];
    if (!handlesBySpace.has(row.space_id)) handlesBySpace.set(row.space_id, existingHandles);

    const current = row.handle?.trim();
    const handle =
      current && validateSlug(current) === null && !existingHandles.includes(current)
        ? current
        : generateValidHandle(row.name, existingHandles);
    existingHandles.push(handle);
    if (row.handle !== handle) {
      db.prepare(`UPDATE space_agents SET handle = ? WHERE id = ?`).run(handle, row.id);
    }
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_space_agents_handle
    ON space_agents(space_id, handle)
    WHERE handle IS NOT NULL
  `);
}

export function runMigration149(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_credentials (
      provider_id TEXT PRIMARY KEY,
      encrypted_data BLOB NOT NULL,
      iv BLOB NOT NULL,
      tag BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

function runMigration150(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      provider_id TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('built_in', 'custom_endpoint')),
      auth_type TEXT NOT NULL CHECK(auth_type IN ('api_key', 'oauth', 'none')),
      is_enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      base_url TEXT,
      config_json TEXT,
      custom_endpoint_config_json TEXT,
      health_status TEXT NOT NULL DEFAULT 'unknown' CHECK(health_status IN ('unknown', 'healthy', 'unhealthy')),
      last_health_check_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_providers_provider_id ON providers(provider_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_providers_sort_order ON providers(sort_order)`);
}

export function runMigration151(db: BunDatabase): void {
  const hasLegacy = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'space_agent_event_subscriptions'`
    )
    .get();
  if (!hasLegacy) return;

  runMigration152(db);

  const now = Date.now();
  const hasSpaceAgentStatus = tableHasColumn(db, 'space_agents', 'status');
  const hasSpaceAgentCustomPrompt = tableHasColumn(db, 'space_agents', 'custom_prompt');
  const hasSpaceAgentProvider = tableHasColumn(db, 'space_agents', 'provider');
  const hasSpaceAgentSettingSources = tableHasColumn(db, 'space_agents', 'setting_sources');
  const statusExpr = hasSpaceAgentStatus
    ? `COALESCE(NULLIF(space_agents.status, ''), 'active')`
    : `'active'`;
  const instructionsExpr = hasSpaceAgentCustomPrompt
    ? `COALESCE(space_agents.custom_prompt, space_agents.instructions, space_agents.system_prompt, '')`
    : `COALESCE(space_agents.instructions, space_agents.system_prompt, '')`;
  const providerExpr = hasSpaceAgentProvider ? `space_agents.provider` : `NULL`;
  const settingSourcesExpr = hasSpaceAgentSettingSources ? `space_agents.setting_sources` : `NULL`;

  db.prepare(
    `INSERT OR IGNORE INTO space_long_horizon_agents (
      id, space_id, handle, display_name, template_key, status, session_id,
      instructions, autonomy_level, model, thinking_level, provider, setting_sources,
      tool_permissions_json, created_at, updated_at
    )
    SELECT
      legacy.agent_id,
      legacy.space_id,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM space_long_horizon_agents existing
          WHERE existing.space_id = legacy.space_id
            AND existing.id != legacy.agent_id
            AND existing.status != 'archived'
            AND existing.handle = COALESCE(space_agents.handle, space_agents.name, legacy.agent_id)
        ) THEN COALESCE(space_agents.handle, space_agents.name, legacy.agent_id) || '-' || legacy.agent_id
        ELSE COALESCE(space_agents.handle, space_agents.name, legacy.agent_id)
      END,
      COALESCE(space_agents.name, space_agents.handle, legacy.agent_id),
      'migration.legacy_space_agent',
      ${statusExpr},
      NULL,
      ${instructionsExpr},
      NULL,
      space_agents.model,
      NULL,
      ${providerExpr},
      ${settingSourcesExpr},
      CASE
        WHEN space_agents.tools IS NULL OR space_agents.tools = '' OR space_agents.tools = '[]' THEN '{}'
        ELSE json_object('tools', json(space_agents.tools))
      END,
      COALESCE(space_agents.created_at, legacy.created_at, ?),
      ?
    FROM space_agent_event_subscriptions legacy
    LEFT JOIN space_agents ON space_agents.id = legacy.agent_id AND space_agents.space_id = legacy.space_id
    GROUP BY legacy.space_id, legacy.agent_id`
  ).run(now, now);

  db.prepare(
    `INSERT OR IGNORE INTO space_long_horizon_agent_event_subscriptions (
      id, space_id, agent_id, source, topic, filter_json, status, created_at, updated_at
    )
    SELECT
      'm151:' || legacy.space_id || ':' || legacy.agent_id || ':' || legacy.topic_pattern || ':' || COALESCE(legacy.label, ''),
      legacy.space_id,
      legacy.agent_id,
      substr(legacy.topic_pattern, 1, instr(legacy.topic_pattern || '/', '/') - 1),
      legacy.topic_pattern,
      CASE
        WHEN legacy.label IS NULL OR legacy.label = '' THEN '{}'
        ELSE json_object('label', legacy.label)
      END,
      'active',
      legacy.created_at,
      ?
    FROM space_agent_event_subscriptions legacy
    JOIN space_long_horizon_agents agents ON agents.id = legacy.agent_id AND agents.space_id = legacy.space_id`
  ).run(now);
  db.exec(`DROP TABLE IF EXISTS space_agent_event_subscriptions`);
}

function runMigration152(db: BunDatabase): void {
  if (!tableExists(db, 'space_long_horizon_agents')) return;
  if (!tableHasColumn(db, 'space_long_horizon_agents', 'provider')) {
    db.exec(`ALTER TABLE space_long_horizon_agents ADD COLUMN provider TEXT DEFAULT NULL`);
  }
  if (!tableHasColumn(db, 'space_long_horizon_agents', 'setting_sources')) {
    db.exec(`ALTER TABLE space_long_horizon_agents ADD COLUMN setting_sources TEXT DEFAULT NULL`);
  }
}

export function runMigration154(db: BunDatabase): void {
  if (!tableExists(db, 'space_github_watched_repos')) return;
  const columns: Array<[string, string]> = [
    ['webhook_remote_id', 'INTEGER'],
    ['webhook_url', 'TEXT'],
    ['webhook_auto_registered', 'INTEGER NOT NULL DEFAULT 0'],
    ['webhook_active', 'INTEGER'],
    ['webhook_last_checked_at', 'INTEGER'],
    ['webhook_last_error', 'TEXT'],
    ['webhook_configured_at', 'INTEGER'],
  ];
  for (const [name, definition] of columns) {
    if (!tableHasColumn(db, 'space_github_watched_repos', name)) {
      db.exec(`ALTER TABLE space_github_watched_repos ADD COLUMN ${name} ${definition}`);
    }
  }
}

export function runMigration155(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_markers (
      key TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const markerKey = 'm154_legacy_long_horizon_agent_data';
  const existing = db.prepare(`SELECT key FROM migration_markers WHERE key = ?`).get(markerKey);
  if (existing) return;
  if (
    !tableExists(db, 'space_agent_goal_assignments') ||
    !tableExists(db, 'space_agent_forge_scope_assignments') ||
    !tableExists(db, 'space_agent_reminders') ||
    !tableExists(db, 'space_long_horizon_agents')
  ) {
    return;
  }
  migrateLegacyLongHorizonAgentData(db);
  db.prepare(`INSERT INTO migration_markers (key, applied_at) VALUES (?, ?)`).run(
    markerKey,
    Date.now()
  );
}

export function runMigration156(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) return;
  if (!tableHasColumn(db, 'sessions', 'acp_session_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN acp_session_id TEXT`);
  }
}

export function runMigration157(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_markers (
      key TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const markerKey = 'm157_archive_terminal_space_task_worker_sessions';
  const existing = db.prepare(`SELECT key FROM migration_markers WHERE key = ?`).get(markerKey);
  if (existing) return;
  if (!tableExists(db, 'sessions') || !tableExists(db, 'space_tasks')) return;

  const terminalSessionPredicate = `
    s.status != 'archived'
    AND COALESCE(s.type, 'worker') NOT IN ('room_chat', 'space_chat', 'spaces_global')
    AND EXISTS (
      SELECT 1
      FROM space_tasks t
      WHERE t.status IN ('done', 'cancelled', 'archived')
        AND (
          (json_valid(s.session_context) AND json_extract(s.session_context, '$.taskId') = t.id)
          OR s.id = t.task_agent_session_id
          OR s.id LIKE ('space:%:task:' || t.id || ':%')
        )
    )
  `;

  if (tableExists(db, 'message_search_content')) {
    db.exec(`
      DELETE FROM message_search_content
      WHERE kind = 'message'
        AND session_id IN (
          SELECT s.id
          FROM sessions s
          WHERE ${terminalSessionPredicate}
        )
    `);
  }

  db.exec(`
    UPDATE sessions AS s
    SET status = 'archived',
        archived_at = COALESCE(archived_at, datetime('now'))
    WHERE ${terminalSessionPredicate}
  `);

  db.prepare(`INSERT INTO migration_markers (key, applied_at) VALUES (?, ?)`).run(
    markerKey,
    Date.now()
  );
}

export function runMigration158(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_markers (
      key TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const markerKey = 'm158_cleanup_terminal_space_runtime_state';
  const existing = db.prepare(`SELECT key FROM migration_markers WHERE key = ?`).get(markerKey);
  if (existing) return;

  if (tableExists(db, 'sessions') && tableExists(db, 'space_tasks')) {
    const terminalSessionPredicate = `
      s.status != 'archived'
      AND COALESCE(s.type, 'worker') NOT IN ('room_chat', 'space_chat', 'spaces_global')
      AND EXISTS (
        SELECT 1
        FROM space_tasks t
        WHERE t.status IN ('done', 'cancelled', 'archived')
          AND (
            (json_valid(s.session_context) AND json_extract(s.session_context, '$.taskId') = t.id)
            OR s.id = t.task_agent_session_id
            OR s.id LIKE ('space:%:task:' || t.id || ':%')
          )
      )
    `;

    if (tableExists(db, 'message_search_content')) {
      db.exec(`
        DELETE FROM message_search_content
        WHERE kind = 'message'
          AND session_id IN (
            SELECT s.id
            FROM sessions s
            WHERE ${terminalSessionPredicate}
          )
      `);
    }

    db.exec(`
      UPDATE sessions AS s
      SET status = 'archived',
          archived_at = COALESCE(archived_at, datetime('now'))
      WHERE ${terminalSessionPredicate}
    `);
  }

  if (tableExists(db, 'node_executions') && tableExists(db, 'space_workflow_runs')) {
    db.exec(`
      UPDATE node_executions
      SET status = CASE
            WHEN (
              SELECT wr.status
              FROM space_workflow_runs wr
              WHERE wr.id = node_executions.workflow_run_id
            ) = 'done'
              THEN 'done'
            ELSE 'cancelled'
          END,
          completed_at = COALESCE(completed_at, updated_at, created_at, unixepoch() * 1000),
          updated_at = unixepoch() * 1000
      WHERE status IN ('in_progress', 'blocked', 'waiting_rebind')
        AND EXISTS (
          SELECT 1
          FROM space_workflow_runs wr
          WHERE wr.id = node_executions.workflow_run_id
            AND wr.status IN ('done', 'cancelled')
        )
    `);
  }

  db.prepare(`INSERT INTO migration_markers (key, applied_at) VALUES (?, ?)`).run(
    markerKey,
    Date.now()
  );
}

export function runMigration159(db: BunDatabase): void {
  widenEvolutionEvidenceKinds(db);
}

export function runMigration160(db: BunDatabase): void {
  widenEvolutionEvidenceKinds(db);
}

export function runMigration161(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) return;
  if (!tableHasColumn(db, 'sessions', 'last_error')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN last_error TEXT`);
  }
}

export function runMigration162(db: BunDatabase): void {
  if (tableExists(db, 'sdk_messages')) {
    db.prepare(
      `UPDATE sdk_messages SET message_type = 'hyperneo_action' WHERE message_type = 'neokai_action'`
    ).run();
    if (tableHasColumn(db, 'sdk_messages', 'sdk_message')) {
      db.prepare(
        `UPDATE sdk_messages
           SET sdk_message = json_set(sdk_message, '$.type', 'hyperneo_action')
         WHERE json_valid(sdk_message) AND json_extract(sdk_message, '$.type') = 'neokai_action'`
      ).run();
    }
  }
  if (
    tableExists(db, 'evolution_episodes') &&
    tableHasColumn(db, 'evolution_episodes', 'findings_json')
  ) {
    db.prepare(
      `UPDATE evolution_episodes
         SET findings_json = REPLACE(findings_json, '"neokai_product"', '"hyperneo_product"')
       WHERE findings_json LIKE '%"neokai_product"%'`
    ).run();
  }
}

export function runMigration167(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;

  if (statusCheckContains(db, 'space_tasks', 'rate_limited')) {
    if (!tableHasColumn(db, 'space_tasks', 'restrictions')) {
      db.exec(`ALTER TABLE space_tasks ADD COLUMN restrictions TEXT`);
    }
    return;
  }

  const currentSql = tableCreateSql(db, 'space_tasks');

  if (currentSql && currentSql.includes('status IN (')) {
    const newTableSql = addRateUsageStatusAndRestrictions(
      replaceCreateTableName(currentSql, 'space_tasks_m167_new')
    );
    const copyColumns = tableColumnNames(db, 'space_tasks').map(quoteSqlIdent).join(', ');
    const existingIndexDdl = capturedIndexDdl(db, 'space_tasks');

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`DROP TABLE IF EXISTS space_tasks_m167_new`);
      db.exec(newTableSql);
      db.exec(
        `INSERT INTO space_tasks_m167_new (${copyColumns}) SELECT ${copyColumns} FROM space_tasks`
      );
      db.exec(`DROP TABLE space_tasks`);
      db.exec(`ALTER TABLE space_tasks_m167_new RENAME TO space_tasks`);
      recreateCompatibleIndexes(db, 'space_tasks', existingIndexDdl);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  if (!tableHasColumn(db, 'space_tasks', 'restrictions')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN restrictions TEXT`);
  }
}

function addRateUsageStatusAndRestrictions(createSql: string): string {
  let statusMatched = false;
  let result = createSql.replace(
    /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i,
    (match, values: string) => {
      statusMatched = true;
      if (values.includes("'rate_limited'")) {
        return match;
      }
      return `CHECK(status IN ('rate_limited', 'usage_limited', ${values.trim()}))`;
    }
  );
  if (!statusMatched) {
    throw new Error('Migration 167: space_tasks status CHECK constraint not found');
  }

  if (!/\brestrictions\s+TEXT\b/i.test(result)) {
    if (/\bFOREIGN\s+KEY\b/i.test(result)) {
      result = result.replace(/\bFOREIGN\s+KEY\b/i, 'restrictions TEXT,\n\t\t\t\t\t\tFOREIGN KEY');
    } else {
      result = result.replace(/\)\s*$/, ',\n\t\t\t\t\t\trestrictions TEXT\n\t\t\t\t\t)');
    }
  }
  return result;
}

export function runMigration163(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) return;

  if (!tableHasColumn(db, 'sdk_messages', 'sdk_uuid')) {
    db.exec(`ALTER TABLE sdk_messages ADD COLUMN sdk_uuid TEXT`);
  }
  if (!tableHasColumn(db, 'sdk_messages', 'replacement_metadata_normalized')) {
    db.exec(`
      ALTER TABLE sdk_messages
      ADD COLUMN replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sdk_message_replacements (
      source_message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT,
      target_uuid TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('superseded', 'retracted')),
      PRIMARY KEY (source_message_id, target_uuid, kind),
      FOREIGN KEY (source_message_id) REFERENCES sdk_messages(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sdk_messages_unnormalized_replacements
    ON sdk_messages(id) WHERE replacement_metadata_normalized = 0
  `);

  reconcileSdkMessageReplacementProjection(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_uuid
    ON sdk_messages(session_id, sdk_uuid)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sdk_message_replacements_session_target
    ON sdk_message_replacements(session_id, target_uuid)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sdk_message_replacements_task_target
    ON sdk_message_replacements(task_id, target_uuid)
  `);
}

export function runMigration166(db: BunDatabase): void {
  migrateLegacyArtifactsToShapes(db);
}

export function migrateLegacyArtifactsToShapes(db: BunDatabase): void {
  if (!tableExists(db, 'workflow_run_artifacts')) return;

  const legacyCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM workflow_run_artifacts
          WHERE artifact_type NOT IN ('link','commit_set','check','metric','decision','note')`
      )
      .get() as { n: number }
  ).n;
  if (legacyCount === 0) return;

  interface Row {
    id: string;
    run_id: string;
    node_id: string;
    artifact_type: string;
    artifact_key: string;
    data: string;
    created_at: number;
    updated_at: number;
  }
  interface Plan {
    id: string;
    runId: string;
    nodeId: string;
    type: string;
    key: string;
    data: string;
    changed: boolean;
    createdAt: number;
    updatedAt: number;
  }

  const rows = db
    .prepare(
      `SELECT id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at
         FROM workflow_run_artifacts`
    )
    .all() as Row[];

  const plans: Plan[] = [];
  for (const row of rows) {
    if (isArtifactShape(row.artifact_type)) {
      plans.push({
        id: row.id,
        runId: row.run_id,
        nodeId: row.node_id,
        type: row.artifact_type,
        key: row.artifact_key,
        data: row.data,
        changed: false,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
      continue;
    }

    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      data = {};
    }
    const originalType = row.artifact_type;
    const originalKey = row.artifact_key ?? '';
    const shape = resolveLegacyShape(originalType, data);

    let newType: string;
    let newKey: string;
    let newData: Record<string, unknown>;
    if (!shape) {
      newType = 'note';
      newKey = originalKey || originalType;
      newData = { ...data, _legacyType: originalType };
    } else {
      newType = shape;
      newData = data;
      if (shape === 'link') {
        newData = normalizeLinkData(data);
        if (originalType === 'pr' && !newData.kind) {
          newData = { ...newData, kind: 'pr' };
        } else if (originalType === 'result' && !newData.kind) {
          if (typeof data.pr_url === 'string' || typeof data.prUrl === 'string')
            newData = { ...newData, kind: 'pr' };
          else if (typeof data.review_url === 'string') newData = { ...newData, kind: 'review' };
        }
      } else if (shape === 'decision' && originalType === 'review' && !data.kind) {
        newData = { ...data, kind: 'review' };
      }
      if (originalType === 'progress') {
        newKey = 'current';
      } else {
        newKey = originalKey || deriveArtifactKey(shape as ArtifactShape, newData);
      }
    }

    plans.push({
      id: row.id,
      runId: row.run_id,
      nodeId: row.node_id,
      type: newType,
      key: newKey,
      data: JSON.stringify(newData),
      changed: true,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  const winnerById = new Map<string, Plan>();
  const loserIds: string[] = [];
  for (const plan of plans) {
    const groupKey = `${plan.runId}|${plan.nodeId}|${plan.type}|${plan.key}`;
    const existing = winnerById.get(groupKey);
    if (!existing) {
      winnerById.set(groupKey, plan);
      continue;
    }
    const keepsExisting =
      existing.updatedAt > plan.updatedAt ||
      (existing.updatedAt === plan.updatedAt && existing.createdAt >= plan.createdAt);
    if (keepsExisting) {
      loserIds.push(plan.id);
    } else {
      loserIds.push(existing.id);
      winnerById.set(groupKey, plan);
    }
  }

  const deleteStmt = db.prepare(`DELETE FROM workflow_run_artifacts WHERE id = ?`);
  for (const id of loserIds) deleteStmt.run(id);

  const updateStmt = db.prepare(
    `UPDATE workflow_run_artifacts SET artifact_type = ?, artifact_key = ?, data = ? WHERE id = ?`
  );
  for (const plan of winnerById.values()) {
    if (!plan.changed) continue;
    updateStmt.run(plan.type, plan.key, plan.data, plan.id);
  }
}

export function reconcileSdkMessageReplacementProjection(db: BunDatabase): void {
  if (
    !tableExists(db, 'sdk_messages') ||
    !tableExists(db, 'sdk_message_replacements') ||
    !tableHasColumn(db, 'sdk_messages', 'sdk_uuid') ||
    !tableHasColumn(db, 'sdk_messages', 'replacement_metadata_normalized')
  ) {
    return;
  }

  db.exec(`
    UPDATE sdk_messages
       SET sdk_uuid = CASE
         WHEN json_valid(sdk_message)
          AND json_type(sdk_message, '$.uuid') = 'text'
          AND json_extract(sdk_message, '$.uuid') != ''
         THEN json_extract(sdk_message, '$.uuid')
         ELSE NULL
       END
     WHERE replacement_metadata_normalized = 0
  `);

  db.exec(`
    INSERT OR IGNORE INTO sdk_message_replacements (
      source_message_id, session_id, task_id, target_uuid, kind
    )
    SELECT sm.id, sm.session_id, sm.task_id, superseded.value, 'superseded'
      FROM sdk_messages sm
      JOIN json_each(
        CASE WHEN json_valid(sm.sdk_message) THEN sm.sdk_message ELSE '{}' END,
        '$.supersedes'
     ) superseded
     WHERE sm.replacement_metadata_normalized = 0
       AND json_type(
         CASE WHEN json_valid(sm.sdk_message) THEN sm.sdk_message ELSE '{}' END,
         '$.supersedes'
       ) = 'array'
       AND typeof(superseded.value) = 'text'
       AND superseded.value != ''
  `);
  db.exec(`
    INSERT OR IGNORE INTO sdk_message_replacements (
      source_message_id, session_id, task_id, target_uuid, kind
    )
    SELECT sm.id, sm.session_id, sm.task_id, retracted.value, 'retracted'
      FROM sdk_messages sm
      JOIN json_each(
        CASE WHEN json_valid(sm.sdk_message) THEN sm.sdk_message ELSE '{}' END,
        '$.retracted_message_uuids'
     ) retracted
     WHERE sm.replacement_metadata_normalized = 0
       AND sm.message_subtype = 'model_refusal_fallback'
       AND json_type(
         CASE WHEN json_valid(sm.sdk_message) THEN sm.sdk_message ELSE '{}' END,
         '$.retracted_message_uuids'
       ) = 'array'
       AND typeof(retracted.value) = 'text'
       AND retracted.value != ''
  `);

  db.exec(`
    UPDATE sdk_messages
       SET replacement_metadata_normalized = 1
     WHERE replacement_metadata_normalized = 0
  `);
}

export function runMigration164(db: BunDatabase): void {
  if (!tableExists(db, 'space_external_event_deliveries')) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_space_external_event_deliveries_pending
    ON space_external_event_deliveries(updated_at)
    WHERE state = 'pending'
  `);
}

export function runMigration165(db: BunDatabase): void {
  if (!tableExists(db, 'space_external_event_deliveries')) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_space_external_event_deliveries_state_updated
    ON space_external_event_deliveries(state, updated_at)
  `);
}

export function runMigration168(db: BunDatabase): void {
  if (!tableHasColumn(db, 'node_executions', 'agent_session_id')) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_node_executions_agent_session
    ON node_executions(agent_session_id)
  `);
}

export function runMigration169(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) return;

  const hasNormColumn = !!db
    .prepare(
      `SELECT name FROM pragma_table_xinfo('sdk_messages') WHERE name = 'message_subtype_norm'`
    )
    .get();
  if (!hasNormColumn) {
    db.exec(`
      ALTER TABLE sdk_messages
        ADD COLUMN message_subtype_norm TEXT GENERATED ALWAYS AS (COALESCE(message_subtype, '')) VIRTUAL
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sdk_messages_session_subtype_parent
    ON sdk_messages(session_id, message_subtype_norm, parent_tool_use_id)
  `);
}

export function runMigration173(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) return;
  db.exec(`DROP INDEX IF EXISTS idx_sdk_messages_session`);
  db.exec(`DROP INDEX IF EXISTS idx_sdk_messages_uuid_status`);
}

export function runMigration174(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;
  const required = ['space_id', 'status', 'updated_at', 'id'];
  if (required.some((col) => !tableHasColumn(db, 'space_tasks', col))) return;
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_tasks_space_status_updated ON space_tasks(space_id, status, updated_at DESC, id DESC)`
  );
}

export function runMigration175(db: BunDatabase): void {
  if (!tableExists(db, 'space_external_events')) return;
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_external_events_recency
     ON space_external_events(space_id, source, ingested_at)`
  );
}

export function runMigration176(db: BunDatabase): void {
  if (
    tableExists(db, 'space_tasks') &&
    !tableHasColumn(db, 'space_tasks', 'post_approval_source_node_id')
  ) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN post_approval_source_node_id TEXT DEFAULT NULL`);
  }
  if (
    tableHasColumn(db, 'space_tasks', 'post_approval_source_node_id') &&
    tableHasColumn(db, 'space_tasks', 'pending_completion_submitted_by_node_id')
  ) {
    const completionSignalledInProgress = tableHasColumn(db, 'space_tasks', 'reported_status')
      ? ` OR (status = 'in_progress' AND reported_status = 'done')`
      : '';
    db.exec(
      `UPDATE space_tasks
         SET post_approval_source_node_id = pending_completion_submitted_by_node_id
       WHERE pending_completion_submitted_by_node_id IS NOT NULL
         AND post_approval_source_node_id IS NULL
         AND (status IN ('review', 'approved')${completionSignalledInProgress})`
    );
  }
  if (tableHasColumn(db, 'space_tasks', 'pending_checkpoint_type')) {
    db.exec(
      `UPDATE space_tasks
         SET pending_checkpoint_type = NULL,
             pending_completion_submitted_by_node_id = NULL,
             pending_completion_submitted_at = NULL,
             pending_completion_reason = NULL
       WHERE status = 'approved'
         AND (pending_checkpoint_type IS NOT NULL
              OR pending_completion_submitted_by_node_id IS NOT NULL
              OR pending_completion_submitted_at IS NOT NULL
              OR pending_completion_reason IS NOT NULL)`
    );
  }
}

export function runMigration177(db: BunDatabase): void {
  if (!tableExists(db, 'sessions')) return;
  if (!tableHasColumn(db, 'sessions', 'visible_message_count')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN visible_message_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!tableExists(db, 'sdk_messages')) return;

  const excludedSubtypes = [...HIDDEN_SYSTEM_SUBTYPES, 'thinking_tokens']
    .map((s) => `'${s.replace(/'/g, "''")}'`)
    .join(', ');

  db.exec(`
    UPDATE sessions
       SET visible_message_count = COALESCE((
         SELECT COUNT(*) FROM sdk_messages sm
          WHERE sm.session_id = sessions.id
            AND sm.parent_tool_use_id IS NULL
            AND (sm.message_type != 'user'
                 OR COALESCE(sm.send_status, 'consumed') IN ('consumed', 'failed'))
            AND COALESCE(sm.message_subtype, '') NOT IN (${excludedSubtypes})
       ), 0)
  `);
}

export function runMigration178(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) return;

  if (!tableHasColumn(db, 'sdk_messages', 'conversation_turn_index')) {
    db.exec(`ALTER TABLE sdk_messages ADD COLUMN conversation_turn_index INTEGER`);
  }

  db.exec(`DROP TABLE IF EXISTS _m178_turn_backfill`);
  db.exec(`
    CREATE TEMP TABLE _m178_turn_backfill AS
    WITH base AS (
      SELECT
        id, task_id, session_id, timestamp, rowid,
        CASE
          WHEN message_type = 'user'
            AND is_renderable = 1
            AND COALESCE(send_status, 'consumed') IN ('consumed', 'failed')
            THEN 1
          ELSE 0
        END AS is_anchor
      FROM sdk_messages
      WHERE task_id IS NOT NULL
    ),
    anchor_numbered AS (
      SELECT
        id, task_id, session_id, timestamp, rowid, is_anchor,
        SUM(is_anchor) OVER (
          PARTITION BY task_id
          ORDER BY timestamp, rowid
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS global_turn
      FROM base
    )
    SELECT id,
      CASE
        WHEN is_anchor = 1 THEN global_turn
        ELSE COALESCE(
          MAX(CASE WHEN is_anchor = 1 THEN global_turn END) OVER (
            PARTITION BY task_id, session_id
            ORDER BY timestamp, rowid
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ),
          0
        )
      END AS turn_idx
    FROM anchor_numbered
  `);

  db.exec(`
    UPDATE sdk_messages
    SET conversation_turn_index = b.turn_idx
    FROM _m178_turn_backfill b
    WHERE sdk_messages.id = b.id
  `);

  db.exec(`DROP TABLE _m178_turn_backfill`);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_turn
    ON sdk_messages(task_id, conversation_turn_index)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_session_turn
    ON sdk_messages(task_id, session_id, conversation_turn_index)
  `);
}

export function runMigration180(db: BunDatabase): void {
  if (tableExists(db, 'space_workflow_definition_versions')) return;
  db.exec(`
    CREATE TABLE space_workflow_definition_versions (
      workflow_id TEXT NOT NULL,
      version_hash TEXT NOT NULL,
      space_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (workflow_id, version_hash),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_space_workflow_definition_versions_space
    ON space_workflow_definition_versions(space_id)
  `);
}

export function runMigration181(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflow_runs')) return;
  if (tableHasColumn(db, 'space_workflow_runs', 'definition_version')) return;
  const requiredColumns = [
    'space_id',
    'workflow_id',
    'title',
    'description',
    'status',
    'failure_reason',
    'created_at',
    'started_at',
    'updated_at',
    'completed_at',
  ];
  if (requiredColumns.some((column) => !tableHasColumn(db, 'space_workflow_runs', column))) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE space_workflow_runs_m181_new (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        definition_version TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'in_progress', 'done', 'blocked', 'cancelled')),
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
        FOREIGN KEY (workflow_id, definition_version)
          REFERENCES space_workflow_definition_versions(workflow_id, version_hash)
      )
    `);
    db.exec(`
      INSERT INTO space_workflow_runs_m181_new
        (id, space_id, workflow_id, title, description, status, failure_reason,
         created_at, started_at, updated_at, completed_at)
      SELECT id, space_id, workflow_id, title, description, status, failure_reason,
             created_at, started_at, updated_at, completed_at
      FROM space_workflow_runs
    `);
    db.exec(`DROP TABLE space_workflow_runs`);
    db.exec(`ALTER TABLE space_workflow_runs_m181_new RENAME TO space_workflow_runs`);
    db.exec(`CREATE INDEX idx_space_workflow_runs_space_id ON space_workflow_runs(space_id)`);
    db.exec(`CREATE INDEX idx_space_workflow_runs_workflow_id ON space_workflow_runs(workflow_id)`);
    db.exec(`CREATE INDEX idx_space_workflow_runs_status ON space_workflow_runs(status)`);
    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function runMigration184(db: BunDatabase): void {
  runMigration184External(db);
}

export function runMigration185(db: BunDatabase): void {
  runMigration185External(db);
}

export function runMigration196(db: BunDatabase): void {
  runMigration196External(db);
}

export function runMigration186(db: BunDatabase): void {
  if (!tableExists(db, 'job_queue')) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_delivery_session_active
      ON job_queue (json_extract(payload, '$.sessionId'))
      WHERE queue = 'message_delivery' AND status IN ('pending', 'processing')
  `);
}

export function runMigration187(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_turn_end (
      session_id TEXT NOT NULL,
      message_uuid TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      PRIMARY KEY (session_id, message_uuid)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_delivery_turn_end_session
      ON delivery_turn_end(session_id)
  `);
}

export function runMigration188(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) return;
  if (!tableHasColumn(db, 'sdk_messages', 'consumed_seq')) {
    db.exec(`ALTER TABLE sdk_messages ADD COLUMN consumed_seq INTEGER`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_consumed_seq
      ON sdk_messages(consumed_seq)`);
}

export function runMigration189(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_consumed_seq (
      singleton INTEGER PRIMARY KEY DEFAULT 1,
      next_seq INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.exec(`
      INSERT OR IGNORE INTO delivery_consumed_seq (singleton, next_seq) VALUES (1, 1)
    `);
}

export function runMigration190(db: BunDatabase): void {
  db.exec(`DROP TABLE IF EXISTS gate_open_state`);
  db.exec(`DROP TABLE IF EXISTS gate_data`);
  if (tableHasColumn(db, 'space_workflows', 'gates')) {
    db.exec(`ALTER TABLE space_workflows DROP COLUMN gates`);
  }
}

export function runMigration191(db: BunDatabase): void {
  if (!tableExists(db, 'node_executions')) return;
  if (!tableHasColumn(db, 'node_executions', 'last_activity_at')) {
    db.exec(`ALTER TABLE node_executions ADD COLUMN last_activity_at INTEGER`);
  }
}

export function runMigration192(db: BunDatabase): void {
  if (!tableExists(db, 'pending_agent_messages')) return;
  if (!tableHasColumn(db, 'pending_agent_messages', 'delivery_mode')) {
    db.exec(`ALTER TABLE pending_agent_messages ADD COLUMN delivery_mode TEXT`);
  }
}

export function runMigration193(db: BunDatabase): void {
  if (!tableExists(db, 'space_workflow_runs')) return;

  db.exec(`
		CREATE TABLE IF NOT EXISTS channel_cycle_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id TEXT NOT NULL,
			channel_index INTEGER NOT NULL,
			sent_at INTEGER NOT NULL,
			FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_channel_cycle_events_window
		ON channel_cycle_events(run_id, channel_index, sent_at)
	`);
}

export function runMigration194(db: BunDatabase): void {
  if (!tableExists(db, 'job_queue')) return;
  if (!tableHasColumn(db, 'job_queue', 'heartbeat_at')) {
    db.exec(`ALTER TABLE job_queue ADD COLUMN heartbeat_at INTEGER`);
  }
}

export function runMigration195(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;
  if (statusCheckContains(db, 'space_tasks', 'stopped')) return;

  const currentSql = tableCreateSql(db, 'space_tasks');

  if (currentSql && currentSql.includes('status IN (')) {
    const newTableSql = addStoppedStatusToSpaceTasks(
      replaceCreateTableName(currentSql, 'space_tasks_m195_new')
    );
    const copyColumns = tableColumnNames(db, 'space_tasks').map(quoteSqlIdent).join(', ');
    const existingIndexDdl = capturedIndexDdl(db, 'space_tasks');

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`DROP TABLE IF EXISTS space_tasks_m195_new`);
      db.exec(newTableSql);
      db.exec(
        `INSERT INTO space_tasks_m195_new (${copyColumns}) SELECT ${copyColumns} FROM space_tasks`
      );
      db.exec(`DROP TABLE space_tasks`);
      db.exec(`ALTER TABLE space_tasks_m195_new RENAME TO space_tasks`);
      recreateCompatibleIndexes(db, 'space_tasks', existingIndexDdl);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

function addStoppedStatusToSpaceTasks(createSql: string): string {
  let statusMatched = false;
  const result = createSql.replace(
    /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i,
    (match, values: string) => {
      statusMatched = true;
      if (values.includes("'stopped'")) {
        return match;
      }
      return `CHECK(status IN (${values.trim()}, 'stopped'))`;
    }
  );
  if (!statusMatched) {
    throw new Error('Migration 195: space_tasks status CHECK constraint not found');
  }
  return result;
}

export function runMigration197(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_send_status_timestamp
    ON sdk_messages(session_id, send_status, timestamp)`);
  db.exec(`DROP INDEX IF EXISTS idx_sdk_messages_send_status`);
}

export function runMigration199(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) return;
  db.exec(`DROP INDEX IF EXISTS idx_sdk_messages_type`);
  db.exec(`DROP INDEX IF EXISTS idx_sdk_messages_consumed_seq`);
}

export function runMigration200(db: BunDatabase): void {
  if (!tableExists(db, 'sessions') || !tableHasColumn(db, 'sessions', 'session_context')) {
    return;
  }
  const contextKeyColumns: Array<[string, string]> = [
    ['room_id', '$.roomId'],
    ['space_id', '$.spaceId'],
    ['task_id', '$.taskId'],
  ];
  for (const [column, path] of contextKeyColumns) {
    const columnAlreadyAdded = !!db
      .prepare(`SELECT name FROM pragma_table_xinfo('sessions') WHERE name = ?`)
      .get(column);
    if (columnAlreadyAdded) continue;
    db.exec(
      `ALTER TABLE sessions ADD COLUMN ${column} TEXT GENERATED ALWAYS AS ` +
        `(CASE WHEN json_valid(session_context) THEN json_extract(session_context, '${path}') END) VIRTUAL`
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_room_id ON sessions(room_id) WHERE room_id IS NOT NULL`
  );
  if (tableHasColumn(db, 'sessions', 'metadata')) {
    db.exec(`DROP INDEX IF EXISTS idx_sessions_space_agent_provenance`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_space_agent_provenance ` +
        `ON sessions(space_id, json_extract(metadata, '$.promptProvenance.agentId'))`
    );
  }
}

export function runMigration201(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;
  if (!tableHasColumn(db, 'space_tasks', 'spawn_reservation_token')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN spawn_reservation_token TEXT`);
  }
}

export function runMigration202(db: BunDatabase): void {
  if (!tableExists(db, 'space_tasks')) return;
  if (!tableHasColumn(db, 'space_tasks', 'goal_id')) return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_created
    ON space_tasks(goal_id, created_at DESC, id DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_goal_status_created
    ON space_tasks(goal_id, status, created_at DESC, id DESC)`);
}

export function runMigration203(db: BunDatabase): void {
  if (!tableExists(db, 'space_long_horizon_agent_goals')) return;
  db.exec(`DELETE FROM space_long_horizon_agent_goals AS a
    WHERE a.relationship = 'owner'
      AND EXISTS (
        SELECT 1 FROM space_long_horizon_agent_goals AS o
        WHERE o.relationship = 'owner'
          AND o.goal_id = a.goal_id
          AND (o.created_at < a.created_at
               OR (o.created_at = a.created_at AND o.agent_id < a.agent_id))
      )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_space_lh_agent_goals_one_owner
    ON space_long_horizon_agent_goals(goal_id)
    WHERE relationship = 'owner'`);
}

export function runMigration204(db: BunDatabase): void {
  if (tableExists(db, 'space_goals') && !tableHasColumn(db, 'space_goals', 'revision')) {
    db.exec(`ALTER TABLE space_goals ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
  }
  if (tableExists(db, 'space_tasks') && !tableHasColumn(db, 'space_tasks', 'terminal_generation')) {
    db.exec(`ALTER TABLE space_tasks ADD COLUMN terminal_generation INTEGER NOT NULL DEFAULT 0`);
  }
}

export function runMigration205(db: BunDatabase): void {
  if (!tableExists(db, 'space_goals')) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS space_goal_outcome_notifications (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      terminal_generation INTEGER NOT NULL DEFAULT 0,
      goal_revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'superseded', 'acknowledged', 'rejected')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(goal_id, task_id, terminal_generation),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (goal_id) REFERENCES space_goals(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES space_tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_goal_outcome_notifications_goal_pending
    ON space_goal_outcome_notifications(goal_id, status, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_goal_outcome_notifications_task
    ON space_goal_outcome_notifications(task_id, terminal_generation)`);
}

export function runMigration210(db: BunDatabase): void {
  if (!tableExists(db, 'sdk_messages')) return;
  db.exec(`DROP INDEX IF EXISTS idx_sdk_messages_task_session`);
}
