import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';

const platform = os.platform();
const skipTest = platform === 'win32';

describe('Sandbox Restrictions', { skip: skipTest }, () => {
  let daemon: DaemonServerContext;
  let workspacePath: string;
  let tempDirOutsideWorkspace: string;

  beforeAll(async () => {
    workspacePath = path.join(os.tmpdir(), `hyperneo-sandbox-test-${Date.now()}`);
    await fs.mkdir(workspacePath, { recursive: true });

    tempDirOutsideWorkspace = path.join(os.tmpdir(), `hyperneo-sandbox-outside-${Date.now()}`);
    await fs.mkdir(tempDirOutsideWorkspace, { recursive: true });

    daemon = await createDaemonServer();
  }, 60_000);

  afterAll(async () => {
    if (daemon) {
      await daemon.cleanup();
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }

    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
    } catch {
      console.warn('Failed to cleanup workspace');
    }
    try {
      await fs.rm(tempDirOutsideWorkspace, { recursive: true, force: true });
    } catch {
      console.warn('Failed to cleanup temp dir');
    }
  });

  describe('Filesystem restrictions', () => {
    test('should reject file write outside workspace', async () => {
      const testFilePath = path.join(tempDirOutsideWorkspace, 'test-sandbox.txt');

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox File Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        const messageContent = `Write the text "SANDBOX TEST" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        await waitForIdle(daemon.messageHub, sessionId, 30000);

        const fileExists = await fs
          .access(testFilePath)
          .then(() => true)
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return false;
            }
            throw error;
          });

        expect(fileExists).toBe(false);
      } finally {
        await daemon.messageHub.request('session.delete', { sessionId });
      }
    });

    test('should allow file write inside workspace', async () => {
      const testFilePath = path.join(workspacePath, 'test-inside-workspace.txt');

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox Inside Workspace Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        const messageContent = `Write the text "INSIDE WORKSPACE" to the file test-inside-workspace.txt`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        await waitForIdle(daemon.messageHub, sessionId, 30000);

        const fileContent = await fs.readFile(testFilePath, 'utf-8');
        expect(fileContent).toContain('INSIDE WORKSPACE');
      } finally {
        await daemon.messageHub.request('session.delete', { sessionId });

        try {
          await fs.rm(testFilePath, { force: true });
        } catch {}
      }
    });
  });

  describe('Bash command sandboxing', () => {
    test('should run bash commands in sandbox', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox Bash Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'bypassPermissions',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        const messageContent =
          'Create a file named test-bash-sandbox.txt with content "BASH SANDBOX TEST"';

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        await waitForIdle(daemon.messageHub, sessionId, 30000);

        const testFilePath = path.join(workspacePath, 'test-bash-sandbox.txt');
        const fileContent = await fs.readFile(testFilePath, 'utf-8');
        expect(fileContent).toContain('BASH SANDBOX TEST');
      } finally {
        await daemon.messageHub.request('session.delete', { sessionId });

        try {
          const testFilePath = path.join(workspacePath, 'test-bash-sandbox.txt');
          await fs.rm(testFilePath, { force: true });
        } catch {}
      }
    });
  });

  describe('Sandbox configuration override', () => {
    test('should allow disabling sandbox per session', async () => {
      const testFilePath = path.join(tempDirOutsideWorkspace, 'test-no-sandbox.txt');

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'No Sandbox Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: false,
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        const messageContent = `Write the text "NO SANDBOX" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        await waitForIdle(daemon.messageHub, sessionId, 30000);

        const fileContent = await fs.readFile(testFilePath, 'utf-8');
        expect(fileContent).toContain('NO SANDBOX');
      } finally {
        await daemon.messageHub.request('session.delete', { sessionId });

        try {
          await fs.rm(testFilePath, { force: true });
        } catch {}
      }
    });
  });

  describe('Allowed directory writes', () => {
    test('should allow writes to ~/.claude/ directory (except settings.json)', async () => {
      const homedir = os.homedir();
      const testFilePath = path.join(homedir, '.claude', 'test-sandbox-write.txt');

      await fs.mkdir(path.join(homedir, '.claude'), { recursive: true });

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox Claude Dir Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        const messageContent = `Write the text "CLAUDE DIR TEST" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        await waitForIdle(daemon.messageHub, sessionId, 30000);

        const fileContent = await fs.readFile(testFilePath, 'utf-8');
        expect(fileContent).toContain('CLAUDE DIR TEST');
      } finally {
        await daemon.messageHub.request('session.delete', { sessionId });

        try {
          await fs.rm(testFilePath, { force: true });
        } catch {}
      }
    });

    test('should allow writes to ~/.hyperneo/projects/ directory', async () => {
      const homedir = os.homedir();
      const testFilePath = path.join(homedir, '.hyperneo', 'projects', 'test-sandbox-write.txt');

      await fs.mkdir(path.join(homedir, '.hyperneo', 'projects'), { recursive: true });

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox HyperNeo Dir Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        const messageContent = `Write the text "NEOKAI PROJECTS TEST" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        await waitForIdle(daemon.messageHub, sessionId, 30000);

        const fileContent = await fs.readFile(testFilePath, 'utf-8');
        expect(fileContent).toContain('HYPERNEO PROJECTS TEST');
      } finally {
        await daemon.messageHub.request('session.delete', { sessionId });

        try {
          await fs.rm(testFilePath, { force: true });
        } catch {}
      }
    });
  });

  describe('Denied directory writes', () => {
    test('should deny writes to home directory root', async () => {
      const homedir = os.homedir();
      const testFilePath = path.join(homedir, 'test-sandbox-denied.txt');

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox Home Dir Deny Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        const messageContent = `Write the text "HOME DIR TEST" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        await waitForIdle(daemon.messageHub, sessionId, 30000);

        const fileExists = await fs
          .access(testFilePath)
          .then(() => true)
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return false;
            }
            throw error;
          });

        expect(fileExists).toBe(false);
      } finally {
        await daemon.messageHub.request('session.delete', { sessionId });

        try {
          await fs.rm(testFilePath, { force: true });
        } catch {}
      }
    });

    test('should deny writes to ~/Documents/ directory', async () => {
      const homedir = os.homedir();
      const documentsPath = path.join(homedir, 'Documents');
      const testFilePath = path.join(documentsPath, 'test-sandbox-denied.txt');

      const documentsExists = await fs
        .access(documentsPath)
        .then(() => true)
        .catch(() => false);

      if (!documentsExists) {
        console.log('Skipping ~/Documents/ test - directory does not exist');
        return;
      }

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox Documents Deny Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        const messageContent = `Write the text "DOCUMENTS TEST" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        await waitForIdle(daemon.messageHub, sessionId, 30000);

        const fileExists = await fs
          .access(testFilePath)
          .then(() => true)
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return false;
            }
            throw error;
          });

        expect(fileExists).toBe(false);
      } finally {
        await daemon.messageHub.request('session.delete', { sessionId });

        try {
          await fs.rm(testFilePath, { force: true });
        } catch {}
      }
    });

    test('should deny writes to system directories', async () => {
      const testFilePath = '/etc/test-sandbox-denied.txt';

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox System Dir Deny Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        const messageContent = `Write the text "SYSTEM DIR TEST" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        await waitForIdle(daemon.messageHub, sessionId, 30000);

        const fileExists = await fs
          .access(testFilePath)
          .then(() => true)
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return false;
            }
            throw error;
          });

        expect(fileExists).toBe(false);
      } finally {
        await daemon.messageHub.request('session.delete', { sessionId });

        try {
          await fs.rm(testFilePath, { force: true });
        } catch {}
      }
    });
  });
});
