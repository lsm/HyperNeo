import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import {
  type NeoRoute,
  NeoRoutingLogRepository,
} from '../../storage/repositories/neo-routing-log-repository.ts';

const SHOWN_ROUTES = 12;
const READ_ROUTES = 200;
const CATCH_UP_CHARS = 3_000;

function where(route: NeoRoute, titles: ReadonlyMap<string, string>): string {
  if (route.concernId) return titles.get(route.concernId) ?? route.concernId;
  return route.destination === 'new' ? 'a new topic' : 'a holder';
}

export function renderNeoCatchUp(
  routes: readonly NeoRoute[],
  titles: ReadonlyMap<string, string>
): string {
  if (routes.length === 0) return '';
  const older = routes.slice(0, -SHOWN_ROUTES);
  const recent = routes.slice(-SHOWN_ROUTES);
  const lines = [
    'Catch-up: since your previous turn these messages went straight to holders, oldest first (from the routing log, not transcripts). Use neo.snapshot, work.find or a consultation for detail.',
  ];
  if (older.length > 0) {
    const counts = new Map<string, number>();
    for (const route of older) {
      const name = where(route, titles);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const summary = [...counts].map(([name, count]) => `${name} ×${count}`).join(', ');
    lines.push(`- ${older.length} earlier: ${summary}`);
  }
  for (const route of recent) {
    const at = new Date(route.askedAt).toISOString().slice(11, 16);
    const outcome = route.outcome ? ` → ${route.outcome}` : ' → (no reply yet)';
    lines.push(`- ${at} UTC, ${where(route, titles)}: "${route.ask}"${outcome}`);
  }
  const text = lines.join('\n');
  return text.length > CATCH_UP_CHARS ? `${text.slice(0, CATCH_UP_CHARS)}…` : text;
}

export function loadNeoCatchUpRoutes(db: BunDatabase): NeoRoute[] {
  return new NeoRoutingLogRepository(db).sinceLastMainTurn(READ_ROUTES);
}

export function requireMissedRoutes(
  routes: readonly NeoRoute[]
): { value: NeoRoute[] } | { reason: string } {
  return routes.length > 0 ? { value: [...routes] } : { reason: '' };
}

export function loadNeoConcernTitles(db: BunDatabase): Map<string, string> {
  return new Map(
    (
      db.prepare('SELECT id, title FROM neo_concerns').all() as Array<{ id: string; title: string }>
    ).map((row) => [row.id, row.title.trim()])
  );
}

export const readNeoCatchUp = (superpipe({})('neo-catch-up') as PipelineAPI)
  .input(['db'])
  .pipe(loadNeoCatchUpRoutes, 'db', 'routes')
  .pipe(requireMissedRoutes, 'routes', 'result:catchUp')
  .pipe(loadNeoConcernTitles, 'db', 'titles')
  .pipe(renderNeoCatchUp, ['catchUp', 'titles'], 'catchUp')
  .end('catchUp') as (db: BunDatabase) => string;
