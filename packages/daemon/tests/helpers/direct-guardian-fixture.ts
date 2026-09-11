import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, createReadStream, createWriteStream } from 'node:fs';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runDirectGuardian } from '../../src/lib/space/runtime/direct-guardian-runtime.ts';

const [role, configPath] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (role === 'sdk') {
  appendFileSync(`${configPath}.spawns`, `${process.pid}\n`);
  process.stdin.on('data', (data) => process.stdout.write(data));
  setTimeout(() => process.exit(0), 30_000);
} else if (role === 'guardian') {
  await runDirectGuardian(
    config,
    createReadStream('', { fd: 3 }),
    createWriteStream('', { fd: 4 }),
    process.stdin,
    process.stdout
  );
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'guardian', configPath], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
  });
  process.stdout.write(`${JSON.stringify({ kind: 'owner', pid: child.pid })}\n`);
  child.stdio[4]?.on('data', (data) => process.stdout.write(data));
  child.stdout?.on('data', (data) =>
    process.stdout.write(`${JSON.stringify({ kind: 'sdk_data', data: data.toString() })}\n`)
  );
  child.stderr?.on('data', (data) => process.stderr.write(data));
  child.once('exit', (code) =>
    process.stdout.write(`${JSON.stringify({ kind: 'owner_exit', code })}\n`)
  );
  process.stdin.on('data', (data) => (child.stdio[3] as Writable).write(data));
  child.stdin?.write('sdk-stdio-roundtrip');
  setTimeout(() => process.exit(0), 30_000);
}
