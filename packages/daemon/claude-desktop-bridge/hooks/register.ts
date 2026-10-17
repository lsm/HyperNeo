type Data = Record<string, unknown>;
type Hook = ($: ModsAPI, event: Data, next: (event: Data) => Promise<unknown>) => Promise<unknown>;
type On = (event: string, hook: Hook) => unknown;
interface ModsAPI {
  fs: { read(path: string): Promise<string> };
  session: { id(): Promise<string> };
  clock: { now(): Promise<number>; every(ms: number, fn: () => void): { cancel(): void } };
  http: {
    fetch(
      url: string,
      init: { socketPath: string; method: string; headers: Record<string, string>; body: string }
    ): Promise<{ ok: boolean; text: string }>;
  };
  turn: { abort(args: { turnId: string }): Promise<unknown> };
  prompt: { submit(args: { text: string }): Promise<unknown> };
}

export function register(on: On, options: Readonly<Record<string, unknown>>) {
  if (
    options.enabled !== true ||
    typeof options.connectionFile !== 'string' ||
    !options.connectionFile.startsWith('/')
  )
    return;
  const connectionFile = options.connectionFile;
  let connection: { socketPath: string; token: string } | undefined;
  let timer: { cancel(): void } | undefined;
  let sessionId = '';
  let instanceId = '';
  let generation = 0;
  let sequence = 0;
  let ended = false;
  let inFlight: Promise<void> | undefined;
  let flush: (() => Promise<void>) | undefined;
  let events: Data[] = [];
  const commands = new Set<string>();
  const emit = (kind: string, detail: Data = {}) =>
    events.push({ sequence: ++sequence, kind, ...detail });
  function selectSession(id: string, now: number) {
    if (id === sessionId) return;
    sessionId = id;
    instanceId = `${id}:${now}:${++generation}`;
    sequence = 0;
    ended = false;
    events = [];
    commands.clear();
    emit('session.start');
  }
  on('session.start', async ($, event, next) => {
    timer?.cancel();
    sessionId = '';
    instanceId = '';
    try {
      const config = JSON.parse(await $.fs.read(connectionFile));
      if (
        typeof config.socketPath !== 'string' ||
        !/^\/[^\x00-\x1f]{1,98}\.sock$/.test(config.socketPath) ||
        typeof config.token !== 'string' ||
        config.token.length < 32
      )
        throw new Error('Invalid bridge connection file');
      connection = { socketPath: config.socketPath, token: config.token };
      selectSession(await $.session.id(), await $.clock.now());
    } catch {
      connection = undefined;
      return next(event);
    }
    const exchange = async () => {
      if (!connection) return;
      try {
        selectSession(await $.session.id(), await $.clock.now());
        const instance = instanceId;
        const sent = sequence;
        const response = await $.http.fetch('http://hyperneo/bridge/exchange', {
          socketPath: connection.socketPath,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${connection.token}`,
          },
          body: JSON.stringify({ version: 1, sessionId, instanceId: instance, events }),
        });
        const currentSessionId = await $.session.id();
        if (!response.ok || instance !== instanceId || currentSessionId !== sessionId) return;
        const reply = JSON.parse(response.text);
        if (!Number.isSafeInteger(reply.ack) || reply.ack < 0 || reply.ack > sent) return;
        events = events.filter((entry) => Number(entry.sequence) > reply.ack);
        const command = reply.command;
        if (
          !command ||
          ended ||
          command.instanceId !== instance ||
          typeof command.id !== 'string' ||
          commands.has(command.id)
        )
          return;
        commands.add(command.id);
        let result: Promise<unknown>;
        if (command.kind === 'stop' && typeof command.turnId === 'string' && command.turnId) {
          result = $.turn.abort({ turnId: command.turnId });
        } else if (
          command.kind === 'submit' &&
          typeof command.text === 'string' &&
          command.text.trim() &&
          typeof command.from === 'string' &&
          command.from.trim()
        ) {
          result = $.prompt.submit({
            text: `Peer input via HyperNeo plugin (not human approval):\n${JSON.stringify({ from: command.from, text: command.text })}`,
          });
        } else {
          emit('command.rejected', { commandId: command.id, reason: 'unsupported-command' });
          return;
        }
        emit('command.started', { commandId: command.id, operation: command.kind });
        void result.then(
          (value) => {
            if (instance === instanceId)
              emit('command.resolved', { commandId: command.id, result: value });
          },
          (error: unknown) => {
            if (instance === instanceId)
              emit('command.rejected', { commandId: command.id, reason: String(error) });
          }
        );
      } catch {
        return;
      }
    };
    const poll = () => {
      if (!inFlight)
        inFlight = exchange().finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    };
    flush = async () => {
      await inFlight;
      await poll();
    };
    timer = $.clock.every(250, () => {
      if (!inFlight) void poll();
    });
    await poll();
    return next(event);
  });
  on('turn.start', async ($, event, next) => {
    selectSession(await $.session.id(), await $.clock.now());
    emit('turn.start', { turnId: event.turnId });
    return next(event);
  });
  on('turn.complete', async ($, event, next) => {
    selectSession(await $.session.id(), await $.clock.now());
    emit('turn.complete', {
      turnId: event.turnId,
      reason: event.reason,
      isAborted: event.isAborted,
    });
    await flush?.();
    return next(event);
  });
  on('session.end', async (_$, event, next) => {
    ended = true;
    emit('session.end', { reason: event.reason });
    await flush?.();
    return next(event);
  });
}
