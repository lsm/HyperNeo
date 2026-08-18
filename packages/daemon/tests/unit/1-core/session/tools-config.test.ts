import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ToolsConfigManager } from '../../../../src/lib/session/tools-config';
import type { Database } from '../../../../src/storage/database';
import type { GlobalToolsConfig } from '@hyperneo/shared';

describe('ToolsConfigManager', () => {
  let mockDb: Database;
  let manager: ToolsConfigManager;

  const defaultGlobalToolsConfig: GlobalToolsConfig = {
    systemPrompt: { claudeCodePreset: { allowed: true, defaultEnabled: true } },
    settingSources: { project: { allowed: true, defaultEnabled: true } },
    mcp: { allowProjectMcp: true, defaultProjectMcp: true },
  };

  beforeEach(() => {
    mockDb = {
      getGlobalToolsConfig: mock(() => defaultGlobalToolsConfig),
      saveGlobalToolsConfig: mock(() => {}),
    } as unknown as Database;

    manager = new ToolsConfigManager(mockDb);
  });

  describe('getGlobal', () => {
    it('should return global tools configuration from database', () => {
      const config = manager.getGlobal();

      expect(config).toEqual(defaultGlobalToolsConfig);
      expect(mockDb.getGlobalToolsConfig).toHaveBeenCalled();
    });
  });

  describe('saveGlobal', () => {
    it('should save global tools configuration to database', () => {
      const newConfig: GlobalToolsConfig = {
        ...defaultGlobalToolsConfig,
        mcp: { allowProjectMcp: false, defaultProjectMcp: false },
      };

      manager.saveGlobal(newConfig);

      expect(mockDb.saveGlobalToolsConfig).toHaveBeenCalledWith(newConfig);
    });
  });
});
