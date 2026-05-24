/**
 * Integration test for AppMcpServer.enabled check in skills-based MCP injection.
 *
 * Verifies via the full RPC stack that:
 * 1. An enabled AppMcpServer + enabled skill → server appears in mcp.registry.list
 * 2. Disabling the AppMcpServer via mcp.registry.setEnabled removes it from enabled list
 * 3. A normal session can be created with the skill state intact
 *
 * The core injection filtering logic (disabled AppMcpServer skipped even when skill
 * is enabled) is covered by unit tests in
 * packages/daemon/tests/unit/agent/query-options-builder.test.ts.
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (for daemon startup)
 * - Does NOT make LLM API calls; only tests RPC-level state management
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { AppMcpServer } from '@neokai/shared';
import type { AppSkill } from '@neokai/shared';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('AppMcpServer.enabled check — skills-based MCP injection', () => {
  let daemon: DaemonServerContext;
  let workspacePath: string;

  beforeEach(async () => {
    daemon = await createDaemonServer();
    workspacePath = join(TMP_DIR, `neokai-test-app-mcp-${Date.now()}`);
    mkdirSync(workspacePath, { recursive: true });
  }, 30_000);

  afterEach(async () => {
    if (!daemon) return;
    daemon.kill('SIGTERM');
    await daemon.waitForExit();
  }, 15_000);

  test('enabled AppMcpServer + enabled skill: server appears in registry list as enabled', async () => {
    // Create an AppMcpServer with enabled=true
    const createResult = (await daemon.messageHub.request('mcp.registry.create', {
      name: 'test-echo-server',
      description: 'Echo server for testing',
      sourceType: 'stdio',
      command: 'echo',
      args: ['hello'],
      enabled: true,
    })) as { server: AppMcpServer };
    expect(createResult.server.enabled).toBe(true);
    const serverId = createResult.server.id;

    // Create a skill referencing the AppMcpServer
    const skillResult = (await daemon.messageHub.request('skill.create', {
      params: {
        name: 'test-echo-skill',
        displayName: 'Test Echo Skill',
        description: 'Skill backed by echo server',
        sourceType: 'mcp_server',
        config: { type: 'mcp_server', appMcpServerId: serverId },
        enabled: true,
      },
    })) as { skill: AppSkill };
    expect(skillResult.skill.enabled).toBe(true);

    // Verify AppMcpServer appears in registry with enabled=true
    const listResult = (await daemon.messageHub.request('mcp.registry.list', {})) as {
      servers: AppMcpServer[];
    };
    const server = listResult.servers.find((s) => s.id === serverId);
    expect(server).toBeDefined();
    expect(server!.enabled).toBe(true);

    // Verify skill appears as enabled
    const skillListResult = (await daemon.messageHub.request('skill.list', {})) as {
      skills: AppSkill[];
    };
    const skill = skillListResult.skills.find((s) => s.id === skillResult.skill.id);
    expect(skill).toBeDefined();
    expect(skill!.enabled).toBe(true);
  }, 60_000);

  test('disabling AppMcpServer while skill remains enabled: registry shows server as disabled', async () => {
    // Create an AppMcpServer with enabled=true
    const createResult = (await daemon.messageHub.request('mcp.registry.create', {
      name: 'test-echo-server-2',
      description: 'Echo server for disable test',
      sourceType: 'stdio',
      command: 'echo',
      args: ['hello'],
      enabled: true,
    })) as { server: AppMcpServer };
    const serverId = createResult.server.id;

    // Create + enable skill
    const skillResult = (await daemon.messageHub.request('skill.create', {
      params: {
        name: 'test-echo-skill-2',
        displayName: 'Test Echo Skill 2',
        description: 'Skill backed by echo server 2',
        sourceType: 'mcp_server',
        config: { type: 'mcp_server', appMcpServerId: serverId },
        enabled: true,
      },
    })) as { skill: AppSkill };
    expect(skillResult.skill.enabled).toBe(true);

    // Disable only the AppMcpServer — skill stays enabled
    const disableResult = (await daemon.messageHub.request('mcp.registry.setEnabled', {
      id: serverId,
      enabled: false,
    })) as { server: AppMcpServer };
    expect(disableResult.server.enabled).toBe(false);

    // Skill is still enabled
    const skillListResult = (await daemon.messageHub.request('skill.list', {})) as {
      skills: AppSkill[];
    };
    const skill = skillListResult.skills.find((s) => s.id === skillResult.skill.id);
    expect(skill!.enabled).toBe(true);

    // AppMcpServer is now disabled
    const listResult = (await daemon.messageHub.request('mcp.registry.list', {})) as {
      servers: AppMcpServer[];
    };
    const server = listResult.servers.find((s) => s.id === serverId);
    expect(server!.enabled).toBe(false);
  }, 60_000);

  test('normal session gets enabled AppMcpServer injected into its skill MCP servers', async () => {
    // Create an AppMcpServer with enabled=true
    const serverResult = (await daemon.messageHub.request('mcp.registry.create', {
      name: 'test-echo-server-3',
      description: 'Echo server for session test',
      sourceType: 'stdio',
      command: 'echo',
      args: ['hello'],
      enabled: true,
    })) as { server: AppMcpServer };
    const serverId = serverResult.server.id;

    // Create + enable skill referencing this server
    await daemon.messageHub.request('skill.create', {
      params: {
        name: 'test-echo-skill-3',
        displayName: 'Test Echo Skill 3',
        description: 'Skill backed by echo server 3',
        sourceType: 'mcp_server',
        config: { type: 'mcp_server', appMcpServerId: serverId },
        enabled: true,
      },
    });

    // Create a normal session
    const createResult = (await daemon.messageHub.request('session.create', {
      workspacePath,
      title: 'App MCP Server Test Session',
    })) as { sessionId: string };
    daemon.trackSession(createResult.sessionId);
    expect(createResult.sessionId).toBeString();

    // Directly verify that the session's QueryOptionsBuilder includes the MCP server
    // from the enabled skill + enabled AppMcpServer
    const skillMcpResult = (await daemon.messageHub.request('session.getSkillMcpServers', {
      sessionId: createResult.sessionId,
    })) as { servers: Record<string, unknown> };
    expect(skillMcpResult.servers['test-echo-skill-3']).toBeDefined();
    expect((skillMcpResult.servers['test-echo-skill-3'] as { command: string }).command).toBe(
      'echo'
    );
  }, 60_000);

  test('normal session does not inject disabled AppMcpServer even when skill is enabled', async () => {
    // Create an AppMcpServer initially enabled, then disable it
    const serverResult = (await daemon.messageHub.request('mcp.registry.create', {
      name: 'test-echo-server-4',
      description: 'Echo server to be disabled',
      sourceType: 'stdio',
      command: 'echo',
      args: ['disabled'],
      enabled: true,
    })) as { server: AppMcpServer };
    const serverId = serverResult.server.id;

    // Create + enable skill referencing this server
    await daemon.messageHub.request('skill.create', {
      params: {
        name: 'test-echo-skill-4',
        displayName: 'Test Echo Skill 4',
        description: 'Skill backed by disabled server',
        sourceType: 'mcp_server',
        config: { type: 'mcp_server', appMcpServerId: serverId },
        enabled: true,
      },
    });

    // Disable the AppMcpServer — skill stays enabled
    await daemon.messageHub.request('mcp.registry.setEnabled', { id: serverId, enabled: false });

    // Create a normal session
    const createResult = (await daemon.messageHub.request('session.create', {
      workspacePath,
      title: 'Disabled App MCP Server Test Session',
    })) as { sessionId: string };
    daemon.trackSession(createResult.sessionId);

    // The disabled AppMcpServer must not appear in the session's skill MCP servers
    const skillMcpResult = (await daemon.messageHub.request('session.getSkillMcpServers', {
      sessionId: createResult.sessionId,
    })) as { servers: Record<string, unknown> };
    expect(skillMcpResult.servers['test-echo-skill-4']).toBeUndefined();
  }, 60_000);
});
