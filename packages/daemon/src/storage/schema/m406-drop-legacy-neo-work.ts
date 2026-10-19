import type { Database } from '../sqlite-compat.ts';

const LEGACY_TABLES = [
  'neo_ask_checks',
  'neo_ask_items',
  'neo_ask_work',
  'neo_agent_work_targets',
  'neo_work_checks',
  'neo_work_continues',
  'neo_work_control_failures',
  'neo_work_dependencies',
  'neo_work_driver_targets',
  'neo_work_goals',
  'neo_work_pr_claims',
  'neo_work_prs',
  'neo_work_refusals',
  'neo_work_resources',
  'neo_work_start_intents',
  'neo_work_supersessions',
  'neo_work_wakes',
  'legacy_neo_asks',
  'neo_work',
];

export function runMigration406(db: Database): void {
  for (const table of LEGACY_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
}
