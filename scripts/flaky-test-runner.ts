import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

export type FlakySuite = 'daemon-unit' | 'daemon-online' | 'web' | 'cli' | 'e2e';

export interface FlakyPolicy {
  maxRetries: number;
  quarantineAfterFailures: number;
  createFixTaskAfterQuarantine: boolean;
  fixTaskLabel: string;
}

export interface FlakyTestEntry {
  id: string;
  suite: FlakySuite;
  path: string;
  namePattern: string;
  reason: string;
  addedAt: string;
  expiresAt?: string;
  issueUrl?: string;
}

export interface FlakyRegistry {
  schemaVersion: number;
  policy: FlakyPolicy;
  tests: FlakyTestEntry[];
}

export interface FailedTestCase {
  file: string;
  name: string;
  className: string;
}

interface CliOptions {
  suite: FlakySuite;
  registryPath: string;
  resultsDir: string;
  reportPath: string;
  command: string[];
}

export function loadRegistry(path = 'flaky-tests.json'): FlakyRegistry {
  const registry = JSON.parse(readFileSync(path, 'utf8')) as FlakyRegistry;
  validateRegistry(registry);
  return registry;
}

export function validateRegistry(registry: FlakyRegistry): void {
  if (!Number.isInteger(registry.schemaVersion) || registry.schemaVersion < 1) {
    throw new Error('flaky registry schemaVersion must be a positive integer');
  }
  if (!Number.isInteger(registry.policy.maxRetries) || registry.policy.maxRetries < 0) {
    throw new Error('flaky registry policy.maxRetries must be a non-negative integer');
  }
  if (
    !Number.isInteger(registry.policy.quarantineAfterFailures) ||
    registry.policy.quarantineAfterFailures < 1
  ) {
    throw new Error('flaky registry policy.quarantineAfterFailures must be a positive integer');
  }

  const ids = new Set<string>();
  for (const entry of registry.tests) {
    if (ids.has(entry.id)) {
      throw new Error(`duplicate flaky test id: ${entry.id}`);
    }
    ids.add(entry.id);
    if (!existsSync(entry.path)) {
      throw new Error(`registered flaky test path does not exist: ${entry.path}`);
    }
  }
}

export function parseJUnitFailures(xml: string): FailedTestCase[] {
  const failures: FailedTestCase[] = [];
  const testcasePattern = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;

  for (const match of xml.matchAll(testcasePattern)) {
    const [, attrs, body] = match;
    if (!body.includes('<failure')) {
      continue;
    }

    const className = readXmlAttribute(attrs, 'classname') ?? '';
    failures.push({
      file: readXmlAttribute(attrs, 'file') ?? className,
      name: readXmlAttribute(attrs, 'name') ?? '',
      className,
    });
  }

  return failures;
}

export function parseJUnitErrors(xml: string): string[] {
  const errors: string[] = [];
  const testcasePattern = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;

  for (const match of xml.matchAll(testcasePattern)) {
    const [, attrs, body] = match;
    if (body.includes('<error')) {
      errors.push(
        readXmlAttribute(attrs, 'name') ?? readXmlAttribute(attrs, 'classname') ?? 'unknown'
      );
    }
  }

  const suiteErrorCounts = [
    ...xml.matchAll(/<testsuite\b([^>]*)>/g),
    ...xml.matchAll(/<testsuites\b([^>]*)>/g),
  ]
    .map((match) => Number(readXmlAttribute(match[1], 'errors') ?? '0'))
    .filter((count) => Number.isFinite(count) && count > 0);

  for (const count of suiteErrorCounts) {
    errors.push(`${count} JUnit suite error(s)`);
  }

  return errors;
}

export function parseJUnitFailureFiles(paths: string[]): FailedTestCase[] {
  return paths
    .filter((path) => existsSync(path))
    .flatMap((path) => parseJUnitFailures(readFileSync(path, 'utf8')));
}

export function parseJUnitErrorFiles(paths: string[]): string[] {
  return paths
    .filter((path) => existsSync(path))
    .flatMap((path) => parseJUnitErrors(readFileSync(path, 'utf8')));
}

export function matchKnownFlakyFailures(
  failures: FailedTestCase[],
  registry: FlakyRegistry,
  suite: FlakySuite
): { known: FlakyTestEntry[]; unknown: FailedTestCase[] } {
  const knownById = new Map<string, FlakyTestEntry>();
  const unknown: FailedTestCase[] = [];

  for (const failure of failures) {
    const matched = registry.tests.find(
      (entry) =>
        entry.suite === suite &&
        samePath(entry.path, failure.file) &&
        (failure.name.includes(entry.namePattern) || failure.className.includes(entry.namePattern))
    );

    if (matched) {
      knownById.set(matched.id, matched);
    } else {
      unknown.push(failure);
    }
  }

  return { known: [...knownById.values()], unknown };
}

export function shouldQuarantine(failedAttempts: number, policy: FlakyPolicy): boolean {
  return failedAttempts >= policy.quarantineAfterFailures;
}

function readXmlAttribute(attrs: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = attrs.match(new RegExp(`(?:^|\\s)${escapedName}="([^"]*)"`));
  return match ? unescapeXml(match[1]) : null;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function samePath(registeredPath: string, failurePath: string): boolean {
  const normalizedRegistered = normalizePath(registeredPath);
  const normalizedFailure = normalizePath(failurePath);
  return (
    normalizedFailure === normalizedRegistered ||
    normalizedFailure.endsWith(`/${normalizedRegistered}`) ||
    normalizedRegistered.endsWith(`/${normalizedFailure}`)
  );
}

function normalizePath(path: string): string {
  const repoRelative = path.startsWith(process.cwd()) ? relative(process.cwd(), path) : path;
  return repoRelative.replaceAll('\\', '/').replace(/^\.\//, '');
}

function parseArgs(argv: string[]): CliOptions {
  const separator = argv.indexOf('--');
  if (separator === -1 || separator === argv.length - 1) {
    throw new Error(
      'usage: flaky-test-runner.ts --suite <suite> [--results-dir <dir>] -- <command>'
    );
  }

  let suite: FlakySuite | null = null;
  let registryPath = 'flaky-tests.json';
  let resultsDir = 'test-results';
  let reportPath = 'test-results/flaky-quarantine.json';

  for (let index = 0; index < separator; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--suite') {
      suite = value as FlakySuite;
      index += 1;
    } else if (arg === '--registry') {
      registryPath = value;
      index += 1;
    } else if (arg === '--results-dir') {
      resultsDir = value;
      index += 1;
    } else if (arg === '--report') {
      reportPath = value;
      index += 1;
    } else {
      throw new Error(`unknown flaky-test-runner arg: ${arg}`);
    }
  }

  if (!suite) {
    throw new Error('flaky-test-runner requires --suite');
  }

  return {
    suite,
    registryPath,
    resultsDir,
    reportPath,
    command: argv.slice(separator + 1),
  };
}

function discoverJUnitFiles(resultsDir: string): string[] {
  if (!existsSync(resultsDir)) {
    return [];
  }

  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile() && path.endsWith('.xml')) {
        files.push(path);
      }
    }
  };

  visit(resultsDir);
  return files;
}

function clearJUnitFiles(resultsDir: string): void {
  for (const file of discoverJUnitFiles(resultsDir)) {
    rmSync(file, { force: true });
  }
}

function runCommand(command: string[]): number {
  const [bin, ...args] = command;
  const result = spawnSync(bin, args, { stdio: 'inherit', env: process.env });
  return result.status ?? 1;
}

function writeQuarantineReport(
  path: string,
  suite: FlakySuite,
  failedAttempts: number,
  known: FlakyTestEntry[],
  policy: FlakyPolicy
): void {
  const report = {
    suite,
    failedAttempts,
    quarantined: known.map((entry) => ({
      id: entry.id,
      path: entry.path,
      namePattern: entry.namePattern,
      reason: entry.reason,
      label: policy.fixTaskLabel,
      createFixTask: policy.createFixTaskAfterQuarantine,
    })),
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '## Flaky test quarantine',
      '',
      `Suite: ${suite}`,
      `Failed attempts: ${failedAttempts}`,
      '',
      ...report.quarantined.map(
        (entry) => `- ${entry.id}: ${entry.path} (${entry.namePattern}) — ${entry.reason}`
      ),
      '',
      policy.createFixTaskAfterQuarantine
        ? `Create fix task with label \`${policy.fixTaskLabel}\` for quarantined test(s).`
        : 'Fix task creation disabled by policy.',
      '',
    ];
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'), { flag: 'a' });
  }
}

export function main(argv = process.argv.slice(2)): number {
  const options = parseArgs(argv);
  const registry = loadRegistry(options.registryPath);
  mkdirSync(options.resultsDir, { recursive: true });
  let failedAttempts = 0;
  let lastKnown: FlakyTestEntry[] = [];

  for (let attempt = 0; attempt <= registry.policy.maxRetries; attempt += 1) {
    clearJUnitFiles(options.resultsDir);
    const exitCode = runCommand(options.command);
    if (exitCode === 0) {
      if (attempt > 0) {
        console.log(`Known flaky suite passed after ${attempt} retry attempt(s).`);
      }
      return 0;
    }

    failedAttempts += 1;
    const junitFiles = discoverJUnitFiles(options.resultsDir);
    const errors = parseJUnitErrorFiles(junitFiles);
    if (errors.length > 0) {
      console.error('JUnit errors found outside registered flaky test failures. Blocking CI.');
      for (const error of errors) {
        console.error(`  ${error}`);
      }
      return exitCode;
    }

    const failures = parseJUnitFailureFiles(junitFiles);
    if (failures.length === 0) {
      console.error('Test command failed, but no JUnit failures were found. Blocking CI.');
      return exitCode;
    }

    const { known, unknown } = matchKnownFlakyFailures(failures, registry, options.suite);
    lastKnown = known;

    if (unknown.length > 0 || known.length === 0) {
      console.error('Non-registered test failure found. Blocking CI.');
      for (const failure of unknown) {
        console.error(`  ${failure.file}: ${failure.name}`);
      }
      return exitCode;
    }

    if (attempt < registry.policy.maxRetries) {
      console.log(
        `Only registered flaky tests failed; retrying attempt ${attempt + 1}/${registry.policy.maxRetries}.`
      );
    }
  }

  if (shouldQuarantine(failedAttempts, registry.policy)) {
    writeQuarantineReport(
      options.reportPath,
      options.suite,
      failedAttempts,
      lastKnown,
      registry.policy
    );
    console.log(
      `Quarantined ${lastKnown.length} registered flaky test(s) after ${failedAttempts} failed attempts.`
    );
    return 0;
  }

  return 1;
}

if (import.meta.main) {
  process.exit(main());
}
