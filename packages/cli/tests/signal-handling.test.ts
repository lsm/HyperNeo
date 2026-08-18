import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

describe('Signal Handler Registration', () => {
  const devServerPath = path.join(__dirname, '../src/dev-server.ts');
  const prodServerPath = path.join(__dirname, '../src/prod-server.ts');

  describe('dev-server.ts', () => {
    let sourceCode: string;

    beforeEach(() => {
      sourceCode = fs.readFileSync(devServerPath, 'utf-8');
    });

    test('registers SIGINT handler before createDaemonApp', () => {
      const sigintIndex = sourceCode.indexOf("process.on('SIGINT'");
      const createDaemonIndex = sourceCode.indexOf('createDaemonApp({');

      expect(sigintIndex).toBeGreaterThan(-1);
      expect(createDaemonIndex).toBeGreaterThan(-1);
      expect(sigintIndex).toBeLessThan(createDaemonIndex);
    });

    test('registers SIGTERM handler before createDaemonApp', () => {
      const sigtermIndex = sourceCode.indexOf("process.on('SIGTERM'");
      const createDaemonIndex = sourceCode.indexOf('createDaemonApp({');

      expect(sigtermIndex).toBeGreaterThan(-1);
      expect(createDaemonIndex).toBeGreaterThan(-1);
      expect(sigtermIndex).toBeLessThan(createDaemonIndex);
    });

    test('registers signal handlers before createViteServer', () => {
      const sigintIndex = sourceCode.indexOf("process.on('SIGINT'");
      const createViteIndex = sourceCode.indexOf('createViteServer({');

      expect(sigintIndex).toBeGreaterThan(-1);
      expect(createViteIndex).toBeGreaterThan(-1);
      expect(sigintIndex).toBeLessThan(createViteIndex);
    });

    test('registers signal handlers before Bun.serve', () => {
      const sigintIndex = sourceCode.indexOf("process.on('SIGINT'");
      const bunServeIndex = sourceCode.indexOf('Bun.serve({');

      expect(sigintIndex).toBeGreaterThan(-1);
      expect(bunServeIndex).toBeGreaterThan(-1);
      expect(sigintIndex).toBeLessThan(bunServeIndex);
    });

    test('shutdown function checks if components are initialized', () => {
      expect(sourceCode).toContain('if (server)');
      expect(sourceCode).toContain('if (vite)');
      expect(sourceCode).toContain('if (daemonContext)');
    });

    test('uses nullable variables for components', () => {
      expect(sourceCode).toMatch(/let daemonContext.*\| null/);
      expect(sourceCode).toMatch(/let vite.*\| null/);
      expect(sourceCode).toMatch(/let server.*\| null/);
    });

    test('second Ctrl+C forces immediate exit', () => {
      expect(sourceCode).toContain('if (isShuttingDown)');
      expect(sourceCode).toContain('process.exit(1)');
    });
  });

  describe('prod-server.ts', () => {
    let sourceCode: string;

    beforeEach(() => {
      sourceCode = fs.readFileSync(prodServerPath, 'utf-8');
    });

    test('registers SIGINT handler before createDaemonApp', () => {
      const sigintIndex = sourceCode.indexOf("process.on('SIGINT'");
      const createDaemonIndex = sourceCode.indexOf('createDaemonApp({');

      expect(sigintIndex).toBeGreaterThan(-1);
      expect(createDaemonIndex).toBeGreaterThan(-1);
      expect(sigintIndex).toBeLessThan(createDaemonIndex);
    });

    test('registers SIGTERM handler before createDaemonApp', () => {
      const sigtermIndex = sourceCode.indexOf("process.on('SIGTERM'");
      const createDaemonIndex = sourceCode.indexOf('createDaemonApp({');

      expect(sigtermIndex).toBeGreaterThan(-1);
      expect(createDaemonIndex).toBeGreaterThan(-1);
      expect(sigtermIndex).toBeLessThan(createDaemonIndex);
    });

    test('registers signal handlers before Bun.serve', () => {
      const sigintIndex = sourceCode.indexOf("process.on('SIGINT'");
      const bunServeIndex = sourceCode.indexOf('Bun.serve({');

      expect(sigintIndex).toBeGreaterThan(-1);
      expect(bunServeIndex).toBeGreaterThan(-1);
      expect(sigintIndex).toBeLessThan(bunServeIndex);
    });

    test('shutdown function checks if components are initialized', () => {
      expect(sourceCode).toContain('if (server)');
      expect(sourceCode).toContain('if (daemonContext)');
    });

    test('uses nullable variables for components', () => {
      expect(sourceCode).toMatch(/let daemonContext.*\| null/);
      expect(sourceCode).toMatch(/let server.*\| null/);
    });

    test('second Ctrl+C forces immediate exit', () => {
      expect(sourceCode).toContain('if (isShuttingDown)');
      expect(sourceCode).toContain('process.exit(1)');
    });

    test('has timeout for daemon cleanup', () => {
      expect(sourceCode).toContain('Promise.race');
      expect(sourceCode).toContain('Daemon cleanup timed out');
    });
  });
});

describe('Signal Handler Pattern Consistency', () => {
  const devServerPath = path.join(__dirname, '../src/dev-server.ts');
  const prodServerPath = path.join(__dirname, '../src/prod-server.ts');

  test('both servers have consistent signal handling pattern', () => {
    const devSource = fs.readFileSync(devServerPath, 'utf-8');
    const prodSource = fs.readFileSync(prodServerPath, 'utf-8');

    const devSigintBeforeAsync =
      devSource.indexOf("process.on('SIGINT'") < devSource.indexOf('createDaemonApp({');
    const prodSigintBeforeAsync =
      prodSource.indexOf("process.on('SIGINT'") < prodSource.indexOf('createDaemonApp({');

    expect(devSigintBeforeAsync).toBe(true);
    expect(prodSigintBeforeAsync).toBe(true);
  });

  test('both servers handle graceful shutdown message', () => {
    const devSource = fs.readFileSync(devServerPath, 'utf-8');
    const prodSource = fs.readFileSync(prodServerPath, 'utf-8');

    expect(devSource).toContain('shutting down gracefully');
    expect(prodSource).toContain('shutting down gracefully');
  });

  test('both servers support force exit on second signal', () => {
    const devSource = fs.readFileSync(devServerPath, 'utf-8');
    const prodSource = fs.readFileSync(prodServerPath, 'utf-8');

    expect(devSource).toContain('Forcing exit');
    expect(prodSource).toContain('Forcing exit');
  });
});
