import {
  McpImportService,
  type ImportResult,
  type RefreshAllResult,
} from '../../lib/mcp/mcp-import-service.ts';
import type { Database as Facade } from '../database.ts';
import type { Database } from '../sqlite-compat.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import { AppMcpServerRepository } from './app-mcp-server-repository.ts';

function checked<T extends ImportResult | RefreshAllResult>(result: T): T {
  const failed =
    'results' in result
      ? result.results.find((row) => row.status === 'failed')
      : result.status === 'failed'
        ? (result as ImportResult)
        : undefined;
  if (failed) throw new Error(failed.error ?? 'MCP import persistence failed');
  return result;
}
export class McpImportPersistenceRepository {
  private readonly service: McpImportService;
  constructor(db: Database, changes: ReactiveDatabase) {
    this.service = new McpImportService({
      appMcpServers: new AppMcpServerRepository(db, changes),
    } as Facade);
  }
  file(...args: Parameters<McpImportService['persistFileEntries']>) {
    return checked(this.service.persistFileEntries(...args));
  }
  sources(...args: Parameters<McpImportService['persistSources']>) {
    return checked(this.service.persistSources(...args));
  }
}
