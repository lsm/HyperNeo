import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

export async function delayedSettings(path: string, home: string, delayMs: number) {
  const fifo = spawnSync('/usr/bin/mkfifo', [path]);
  if (fifo.error) throw fifo.error;
  if (fifo.status !== 0) throw new Error(fifo.stderr.toString());
  const writer = spawn(
    '/usr/bin/python3',
    [
      '-c',
      `import json, os, sys, time
path, delay = sys.argv[1:]
content = json.dumps({"custom": "preserved", "attribution": {"commit": "synthetic"}})
print("ready", flush=True)
with open(path, "w") as pipe:
    time.sleep(float(delay) / 1000)
    pipe.write(content)
    pipe.flush()
    os.unlink(path)
    with open(path, "w") as regular:
        regular.write(content)
`,
      path,
      String(delayMs),
    ],
    { env: { HOME: home, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const exited = once(writer, 'exit');
  await Promise.race([
    once(writer.stdout!, 'data'),
    exited.then(() => {
      throw new Error('Synthetic settings writer exited before readiness');
    }),
  ]);
  return {
    done: exited,
    async stop() {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill();
      await exited;
    },
  };
}
