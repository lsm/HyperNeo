import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../../..');
const bun = process.versions.bun
  ? process.execPath
  : process.env.BUN_INSTALL
    ? join(process.env.BUN_INSTALL, 'bin/bun')
    : join(homedir(), '.bun/bin/bun');

test.each(['prod', 'daemon'])(
  'compiled %s entry preserves only explicit test mode',
  (entry) => {
    const run = mkdtempSync(join(tmpdir(), 'hyperneo-entry-env-'));
    const binary = join(run, process.platform === 'win32' ? 'entry.exe' : 'entry');
    const builder = join(run, 'build.ts');
    const guard = join(root, 'packages/daemon/src/lib/credential-discovery.ts');
    const report = `import { usesHumanLogin } from ${JSON.stringify(guard)};
    export function startProdServer(config) {
      const environment = process.env;
      console.log('COMPILED_ENTRY_ENVIRONMENT=' + JSON.stringify({ nodeEnv: environment.NODE_ENV, configEnv: config.nodeEnv, usesHumanLogin: usesHumanLogin() }));
    }
    export const startDaemonServer = startProdServer;
    export const installProcessFatalLogging = () => {};
    export const startAcpMcpProxy = () => {};
    export const runSessionCommand = () => 0;`;
    try {
      mkdirSync(join(run, 'home'));
      mkdirSync(join(run, 'bin'));
      writeFileSync(
        join(run, 'bin/security'),
        '#!/bin/sh\nprintf "synthetic-discovery-attempt\\n" >> "$HYPERNEO_DATA_DIR/security-attempts"\nexit 1\n',
        { mode: 0o700 }
      );
      const env = {
        HOME: join(run, 'home'),
        USERPROFILE: join(run, 'home'),
        PATH: [join(run, 'bin'), '/usr/bin', '/bin'].join(delimiter),
        SystemRoot: process.env.SystemRoot,
      };
      writeFileSync(
        builder,
        `
      const result = await Bun.build({
        entrypoints: [${JSON.stringify(join(root, 'packages/cli', `${entry}-entry.ts`))}],
        target: 'bun', compile: { outfile: ${JSON.stringify(binary)} },
        plugins: [{ name: 'synthetic-server-boundary', setup(build) {
          build.onLoad({ filter: /(?:prod-server-embedded|daemon-server|mcp-proxy-entry|session-cli|process-fatal-logger)\\.ts$/ }, () => ({ contents: ${JSON.stringify(report)}, loader: 'ts' }));
        } }],
      });
      if (!result.success) throw new AggregateError(result.logs, 'entry compilation failed');
    `
      );
      execFileSync(bun, [builder], { cwd: root, env, timeout: 30000, stdio: 'pipe' });
      const evidence = process.env.HYPERNEO_TEST_EVIDENCE_DIR;
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        copyFileSync(binary, join(evidence, `${entry}-compiled`));
        copyFileSync(builder, join(evidence, `${entry}-builder.ts`));
      }
      for (const [index, input] of [
        'test',
        undefined,
        '',
        'development',
        'production',
        'TEST',
      ].entries()) {
        const data = join(run, `data-${index}`);
        mkdirSync(data);
        const stdout = execFileSync(binary, ['--db-path', join(data, 'daemon.db')], {
          cwd: run,
          env: {
            ...env,
            HYPERNEO_DATA_DIR: data,
            ...(input === undefined ? {} : { NODE_ENV: input }),
          },
          timeout: 10000,
          encoding: 'utf8',
        });
        const line = stdout
          .split('\n')
          .find((line) => line.startsWith('COMPILED_ENTRY_ENVIRONMENT='));
        expect(line).toBeDefined();
        const observed = JSON.parse(line!.slice('COMPILED_ENTRY_ENVIRONMENT='.length));
        console.log(entry, input, observed, {
          discoveryAttempted: existsSync(join(data, 'security-attempts')),
        });
        if (evidence)
          writeFileSync(
            join(evidence, `${entry}-${index}.json`),
            JSON.stringify(
              {
                input: input ?? null,
                ...observed,
                discoveryAttempted: existsSync(join(data, 'security-attempts')),
              },
              null,
              2
            )
          );
        if (input === 'test') expect(existsSync(join(data, 'security-attempts'))).toBe(false);
        expect(observed).toEqual({
          nodeEnv: input === 'test' ? 'test' : 'production',
          configEnv: input === 'test' ? 'test' : 'production',
          usesHumanLogin: input !== 'test',
        });
        if (input === 'test') expect(existsSync(join(data, 'security-attempts'))).toBe(false);
      }
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  },
  90000
);
