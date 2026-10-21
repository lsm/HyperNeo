import { expect, test } from 'bun:test';
import { vi } from 'vitest';
import { mirrorNeoWorkspaceProjectsAsync } from '../../../../src/lib/neo/project-mirror-async';

class FixtureWorker {
  onmessage: ((event: { data: { changed: boolean } | { error: string } }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  stopped = false;
  postMessage() {}
  terminate() {
    this.stopped = true;
  }
  asWorker() {
    return this as unknown as Worker;
  }
}
const turn = () => new Promise((done) => setTimeout(done, 0));

test('an unresponsive worker times out and releases the next mirror', async () => {
  vi.useFakeTimers();
  const workers: FixtureWorker[] = [];
  const spawn = () => {
    const worker = new FixtureWorker();
    workers.push(worker);
    return worker.asWorker();
  };
  try {
    const first = mirrorNeoWorkspaceProjectsAsync('/synthetic/timeout.db', [], spawn).then(
      (value) => ({ value }),
      (error: Error) => ({ error: error.message })
    );
    const next = mirrorNeoWorkspaceProjectsAsync('/synthetic/timeout.db', [], spawn);
    await vi.advanceTimersByTimeAsync(30_000);
    const stoppedBeforeReply = workers[0].stopped;
    workers[0].onmessage!({ data: { changed: false } });
    const outcome = await first;
    await vi.advanceTimersByTimeAsync(0);
    workers[1].onmessage!({ data: { changed: false } });
    expect(await next).toBe(false);
    expect(outcome).toEqual({ error: 'Project mirror worker timed out' });
    expect(stoppedBeforeReply).toBe(true);
    expect(workers.every((worker) => worker.stopped)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('same-database mirrors complete in order and retain a false result', async () => {
  const workers: FixtureWorker[] = [];
  const spawn = () => {
    const w = new FixtureWorker();
    workers.push(w);
    return w.asWorker();
  };
  const first = mirrorNeoWorkspaceProjectsAsync('/synthetic/serial.db', [], spawn);
  const second = mirrorNeoWorkspaceProjectsAsync('/synthetic/serial.db', [], spawn);
  await turn();
  expect(workers).toHaveLength(1);
  workers[0].onmessage!({ data: { changed: false } });
  expect(await first).toBe(false);
  await turn();
  expect(workers).toHaveLength(2);
  workers[1].onmessage!({ data: { changed: true } });
  expect(await second).toBe(true);
  expect(workers.every((w) => w.stopped)).toBe(true);
});

test.each(['reply', 'event', 'post', 'spawn'])(
  'a %s failure is reported and a later mirror can retry',
  async (kind) => {
    const w = new FixtureWorker();
    if (kind === 'post')
      w.postMessage = () => {
        throw new Error('synthetic failure');
      };
    const result = mirrorNeoWorkspaceProjectsAsync(`/synthetic/${kind}.db`, [], () => {
      if (kind === 'spawn') throw new Error('synthetic failure');
      return w.asWorker();
    });
    const rejection = expect(result).rejects.toThrow('synthetic failure');
    await turn();
    if (kind === 'reply') w.onmessage!({ data: { error: 'synthetic failure' } });
    if (kind === 'event') w.onerror!({ message: 'synthetic failure' });
    await rejection;
    if (kind !== 'spawn') expect(w.stopped).toBe(true);
    const next = new FixtureWorker();
    const retried = mirrorNeoWorkspaceProjectsAsync(`/synthetic/${kind}.db`, [], () =>
      next.asWorker()
    );
    await turn();
    next.onmessage!({ data: { changed: false } });
    expect(await retried).toBe(false);
    expect(next.stopped).toBe(true);
  }
);
